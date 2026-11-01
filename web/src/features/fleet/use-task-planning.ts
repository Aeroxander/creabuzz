/**
 * Backing, Next up, and "Claim as contribution" for the work board.
 *
 * Backing reactions are read in one bounded request — global rows plus one
 * filter per channel that has tasks, since the relay keeps channel events off
 * global reads — and tallied with the feed's trust weights, so a thousand
 * fresh keys cannot outvote the people with a track record. The pure rules
 * live in `lib/task-planning.ts`.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { KIND_FORUM_POST } from "@/features/board/lib/board-events";
import {
  EMPTY_TALLY,
  tallyVotes,
  type VoteTally,
} from "@/features/feed/lib/ranking";
import { useVoteWeights } from "@/features/feed/use-feed";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import {
  KIND_CONTRIBUTION_RECORD,
  KIND_DELETION,
  KIND_REACTION,
} from "@/shared/constants/kinds";
import { queryEventsHttp } from "@/shared/lib/http-query";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents, type NostrFilter } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  buildTaskBacking,
  buildTaskContribution,
  KIND_TASK,
  taskCoordinate,
} from "./lib/task-planning";
import {
  buildFinderContribution,
  canClaimFinderCredit,
  finderCreditKey,
} from "./lib/task-source";
import type { WorkItem } from "./use-work-board";
import { publishAsUser } from "@/shared/lib/publish-as-user";

/** Channels whose backing is read — bounded so a huge community stays cheap. */
const MAX_BACKING_CHANNELS = 20;
const BACKING_LIMIT = 500;

async function publishSigned(template: {
  kind: number;
  tags: string[][];
  content: string;
}): Promise<void> {
  await publishAsUser(template, "The server refused this change.");
}

export interface TaskPlanning {
  /** Weighted backing for a task (EMPTY_TALLY when nobody backed it). */
  supportOf: (item: WorkItem) => VoteTally;
  back: (item: WorkItem) => Promise<void>;
  unback: (item: WorkItem) => Promise<void>;
  /** File the finished task as your pending contribution. */
  claim: (item: WorkItem) => Promise<void>;
  /** File the finder's credit for a finished task that began as your own board post. */
  claimFinderCredit: (item: WorkItem) => Promise<void>;
  loading: boolean;
  /** Set when backing could not be read; Next up then orders by priority. */
  error: unknown;
}

export function useTaskPlanning(items: readonly WorkItem[]): TaskPlanning {
  const queryClient = useQueryClient();
  const viewer = existingUserPubkey();
  const channels = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.type === "task" && item.scope) ids.add(item.scope);
    }
    return [...ids].sort().slice(0, MAX_BACKING_CHANNELS);
  }, [items]);
  const queryKey = useMemo(
    () => ["task-backing", ...channels] as const,
    [channels],
  );

  const reactions = useQuery({
    queryKey,
    queryFn: () => {
      const base: NostrFilter = {
        kinds: [KIND_REACTION],
        "#k": [String(KIND_TASK)],
        limit: BACKING_LIMIT,
      };
      return queryEventsHttp([
        base,
        ...channels.map((h) => ({ ...base, "#h": [h] })),
      ]);
    },
    staleTime: 20_000,
  });
  const weights = useVoteWeights();

  const tallies = useMemo(
    () => tallyVotes(reactions.data ?? [], weights.data ?? (() => 1), viewer),
    [reactions.data, weights.data, viewer],
  );

  const supportOf = useCallback(
    (item: WorkItem) =>
      item.type === "task"
        ? (tallies.get(taskCoordinate(item.creator, item.id)) ?? EMPTY_TALLY)
        : EMPTY_TALLY,
    [tallies],
  );

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["task-backing"] }),
    [queryClient],
  );

  const back = useCallback(
    async (item: WorkItem) => {
      if (!item.latestRowId) throw new Error("This task cannot be backed yet.");
      await publishSigned(
        buildTaskBacking({
          d: item.id,
          creator: item.creator,
          latestRowId: item.latestRowId,
          channelId: item.scope,
        }),
      );
      await refresh();
    },
    [refresh],
  );

  const unback = useCallback(
    async (item: WorkItem) => {
      const coordinate = taskCoordinate(item.creator, item.id);
      const mine = (reactions.data ?? []).filter(
        (r) =>
          r.pubkey === viewer &&
          r.tags.some((t) => t[0] === "a" && t[1] === coordinate),
      );
      if (mine.length === 0) return;
      const tags = mine.map((r) => ["e", r.id]);
      tags.push(["k", String(KIND_REACTION)]);
      await publishSigned({ kind: KIND_DELETION, tags, content: "" });
      await refresh();
    },
    [reactions.data, viewer, refresh],
  );

  const claim = useCallback(async (item: WorkItem) => {
    // A build without raises (the pilot) has no points: nothing there accepts a claim.
    if (!raisesOffered()) {
      throw new Error(
        "Tasks here earn no points. To earn Shares, take the work on the project's Work tab.",
      );
    }
    if (!item.doneRowId) {
      throw new Error("Only a finished task can be claimed.");
    }
    // One record per finished task, whoever files it: the fleet worker and
    // the CLI key theirs by the same done-row id.
    const existing = await queryEvents(relayWsUrl(), {
      kinds: [KIND_CONTRIBUTION_RECORD],
      "#d": [item.doneRowId],
      limit: 1,
    });
    if (existing.length > 0) {
      throw new Error("This task has already been claimed.");
    }
    await publishSigned(
      buildTaskContribution({
        doneRowId: item.doneRowId,
        title: item.title,
        description: item.description,
        reward: item.reward,
        milestone: item.milestone,
      }),
    );
  }, []);

  const claimFinderCredit = useCallback(
    async (item: WorkItem) => {
      if (!raisesOffered()) {
        throw new Error(
          "Tasks here earn no points, so there is no credit to claim.",
        );
      }
      const { source, doneRowId } = item;
      if (!source || !doneRowId || !canClaimFinderCredit(item, viewer)) {
        throw new Error(
          "Only the person who wrote the post can claim this, once the task is done.",
        );
      }
      // The task row only says who wrote the post; the post itself is the proof.
      const posts = await queryEvents(relayWsUrl(), {
        kinds: [KIND_FORUM_POST],
        "#h": [source.board],
        ids: [source.post],
        limit: 1,
      });
      if (posts[0]?.pubkey.toLowerCase() !== viewer?.toLowerCase()) {
        throw new Error(
          "We couldn't find your post on that board, so the credit can't be filed.",
        );
      }
      const existing = await queryEvents(relayWsUrl(), {
        kinds: [KIND_CONTRIBUTION_RECORD],
        "#d": [finderCreditKey(doneRowId)],
        limit: 1,
      });
      if (existing.length > 0) {
        throw new Error("This credit has already been claimed.");
      }
      await publishSigned(
        buildFinderContribution({
          doneRowId,
          source,
          title: item.title,
          milestone: item.milestone,
        }),
      );
    },
    [viewer],
  );

  return {
    supportOf,
    back,
    unback,
    claim,
    claimFinderCredit,
    loading: reactions.isLoading,
    error: reactions.error,
  };
}
