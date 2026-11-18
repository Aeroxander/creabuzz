/**
 * The Creaton tab's ordering: recency, lifted by engagement, with likes
 * weighted by social trust — more of each as the community grows
 * (`lib/trust.ts`). Following stays strictly chronological.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  KIND_CONTACT_LIST,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";

import { lastTagValue } from "./lib/engagement";
import type { Row } from "./lib/timeline";
import {
  buildFollowGraph,
  graphNodes,
  likerWeight,
  percentiles,
  rankingStrength,
  rankScore,
  seededPageRank,
  trustBlend,
} from "./lib/trust";
import { readEvents } from "./read";
import { useLaunchUpdates } from "./use-launch-updates";
import { socialKeys } from "./use-social-data";

const GRAPH_LIMIT = 2_000;
const PROFILE_LIMIT = 2_000;
const RELATED_CHUNK = 40;
/** A viewer's own follows steer trust; the global graph keeps it honest. */
const PERSONAL_SHARE = 0.5;
/** A priority launch update ranks as if it were this much newer. */
const PRIORITY_UPDATE_BONUS_SECONDS = 6 * 60 * 60;

/** The follow graph and community size, shared by every ranked list. */
function useTrustModel() {
  const me = existingUserPubkey();
  const lists = useQuery({
    queryKey: [...socialKeys.lists, "trust-graph"],
    staleTime: 5 * 60_000,
    queryFn: () =>
      readEvents({ kinds: [KIND_CONTACT_LIST], limit: GRAPH_LIMIT }),
  });
  const profiles = useQuery({
    queryKey: [...socialKeys.lists, "community-size"],
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (await readEvents({ kinds: [KIND_PROFILE], limit: PROFILE_LIMIT }))
        .length,
  });

  return useMemo(() => {
    if (!lists.data || profiles.data === undefined) return null;
    const graph = buildFollowGraph(lists.data);
    const size = Math.max(profiles.data, graphNodes(graph).length);
    const blend = trustBlend(size);
    const mine = me ? [...(graph.get(me) ?? [])] : [];
    const globalRank = percentiles(seededPageRank(graph, []));
    const personalRank =
      me && mine.length > 0
        ? percentiles(seededPageRank(graph, [me, ...mine]))
        : null;
    const percentile = (pubkey: string) => {
      const global = globalRank.get(pubkey) ?? 0;
      const personal = personalRank?.get(pubkey);
      return personal === undefined
        ? global
        : PERSONAL_SHARE * personal + (1 - PERSONAL_SHARE) * global;
    };
    const followed = new Set(mine);
    return {
      size,
      blend,
      strength: rankingStrength(size),
      weightOf: (pubkey: string) =>
        likerWeight(
          {
            percentile: percentile(pubkey),
            followedByViewer: followed.has(pubkey),
          },
          blend,
        ),
    };
  }, [lists.data, profiles.data, me]);
}

/** How the Everyone tab scores a post: one scale for notes and, through {@link boardEngagement}, board posts. */
export interface NoteRanking {
  /** False until the trust model and the loaded notes' engagement are read; scores are then 0. */
  ready: boolean;
  /** A note row's score. */
  scoreNote: (row: Row) => number;
  /** A note's trust-weighted engagement alone (votes, reposts, replies), for Top. */
  engagementOf: (id: string) => number;
  /** A score for any post, from its engagement and when it entered the feed. */
  scoreOf: (engagement: number, at: number) => number;
}

/**
 * Scores for `rows` on the Creaton tab's scale: recency lifted by engagement, each person's newest vote counting once
 * (up adds, down takes away), weighted by trust, with reposts and replies counting too.
 */
export function useNoteRanking(
  rows: readonly Row[],
  enabled: boolean,
): NoteRanking {
  const model = useTrustModel();
  const { priority } = useLaunchUpdates();
  const ids = useMemo(
    () => [...new Set(rows.map((r) => r.event.id))].sort(),
    [rows],
  );
  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += RELATED_CHUNK) {
      out.push(ids.slice(i, i + RELATED_CHUNK));
    }
    return out;
  }, [ids]);
  const { ready, events } = useQueries({
    // `combine` keeps the result referentially stable until the data changes.
    combine: (results) => ({
      ready: results.every((q) => q.isSuccess),
      events: results.flatMap((q) => q.data ?? []),
    }),
    queries: chunks.map((chunk) => ({
      queryKey: [...socialKeys.engagement, "ranking", chunk],
      enabled: enabled && model !== null,
      staleTime: 30_000,
      queryFn: () =>
        readEvents({
          kinds: [KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE],
          "#e": chunk,
          limit: 1000,
        }),
    })),
  });

  return useMemo(() => {
    if (!enabled || !model || !ready) {
      return {
        ready: false,
        scoreNote: () => 0,
        scoreOf: () => 0,
        engagementOf: () => 0,
      };
    }
    const engagement = new Map<string, number>();
    const add = (target: string, amount: number) =>
      engagement.set(target, (engagement.get(target) ?? 0) + amount);
    const seen = new Set<string>();
    // Each person's newest vote on a target counts once.
    const newestVote = new Map<
      string,
      { at: number; id: string; up: boolean }
    >();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const target = lastTagValue(event.tags, "e");
      if (!target) continue;
      if (event.kind === KIND_REACTION) {
        const up = event.content === "+" || event.content === "";
        if (!up && event.content !== "-") continue;
        const key = `${target}\u0000${event.pubkey}`;
        const seenVote = newestVote.get(key);
        if (
          !seenVote ||
          event.created_at > seenVote.at ||
          (event.created_at === seenVote.at && event.id > seenVote.id)
        ) {
          newestVote.set(key, { at: event.created_at, id: event.id, up });
        }
      } else if (event.kind === KIND_REPOST) {
        add(target, 1.5 * model.weightOf(event.pubkey));
      } else if (event.kind === KIND_TEXT_NOTE) {
        add(target, 0.5 * model.weightOf(event.pubkey));
      }
    }
    for (const [key, vote] of newestVote) {
      const [target, voter] = key.split("\u0000");
      add(target, (vote.up ? 1 : -1) * model.weightOf(voter));
    }
    const scoreOf = (amount: number, at: number) =>
      rankScore({ engagement: amount, at }, model.strength);
    const scoreNote = (row: Row) =>
      scoreOf(
        engagement.get(row.event.id) ?? 0,
        (row.repostedBy?.at ?? row.event.created_at) +
          (priority.has(row.event.id) ? PRIORITY_UPDATE_BONUS_SECONDS : 0),
      );
    return {
      ready: true,
      scoreNote,
      scoreOf,
      engagementOf: (id: string) => engagement.get(id) ?? 0,
    };
  }, [enabled, model, ready, events, priority]);
}
