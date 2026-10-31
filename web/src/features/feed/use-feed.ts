import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  KIND_BOOKMARK_LIST,
  KIND_CONTACT_LIST,
  KIND_CONTRIBUTION_RECORD,
  KIND_ORG_GRANT,
  KIND_ORG_NODE,
  KIND_REACTION,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { ethBlockNumber, getRpcEndpoint } from "@/features/launchpad/chain";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type EventTemplate,
  type FeedNote,
  parseNote,
  type SignedEventLike,
} from "./lib/feed-events";
import { createListWriter, type ListWrite } from "./lib/follow-queue";
import { latestList, withLaunch, withPerson } from "./lib/lists";
import {
  isMirrorable,
  KIND_RELAY_LIST,
  MIRROR_TIMEOUT_MS,
  outboxRelays,
  readMirrorSetting,
  withTimeout,
} from "./lib/mirror";
import { tallyVotes, type VoteTally } from "./lib/ranking";
import { orgGraphFromEvents, voteWeights } from "./lib/trust-weight";
import { publishAsUser } from "@/shared/lib/publish-as-user";

/** How many recent notes one feed read pulls. */
const NOTE_LIMIT = 300;
/** Reactions per read: enough for a page of notes and launches. */
const REACTION_LIMIT = 2000;

const feedKeys = {
  notes: ["feed", "notes"] as const,
  launchNotes: (coord: string) => ["feed", "launch-notes", coord] as const,
  reactions: ["feed", "reactions"] as const,
  weights: ["feed", "weights"] as const,
  lists: (pubkey: string) => ["feed", "lists", pubkey] as const,
};

async function fetchNotes(filter: {
  "#a"?: string[];
  authors?: string[];
}): Promise<FeedNote[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_TEXT_NOTE],
    limit: NOTE_LIMIT,
    ...filter,
  });
  return events
    .map((e) => parseNote(e))
    .filter((n): n is FeedNote => n !== null);
}

/** Recent notes community-wide (posts and replies). */
export function useFeedNotes() {
  return useQuery({
    queryKey: feedKeys.notes,
    queryFn: () => fetchNotes({}),
    staleTime: 20_000,
  });
}

/** Every note about one launch: its discussion thread. */
export function useLaunchNotes(coord: string | null) {
  return useQuery({
    queryKey: feedKeys.launchNotes(coord ?? ""),
    queryFn: () => fetchNotes({ "#a": [coord as string] }),
    enabled: Boolean(coord),
    staleTime: 20_000,
  });
}

/**
 * How much each voter counts: from the community's org graph and reviewed
 * contribution records (`lib/trust-weight.ts`).
 */
export function useVoteWeights() {
  return useQuery({
    queryKey: feedKeys.weights,
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_ORG_NODE, KIND_ORG_GRANT, KIND_CONTRIBUTION_RECORD],
        limit: 1000,
      });
      return voteWeights(orgGraphFromEvents(events), events);
    },
    staleTime: 120_000,
  });
}

/** Recent reactions, tallied per target with trust weights. */
export function useVoteTallies(): {
  tallies: Map<string, VoteTally>;
  isLoading: boolean;
} {
  const reactions = useQuery({
    queryKey: feedKeys.reactions,
    queryFn: () =>
      queryEvents(relayWsUrl(), {
        kinds: [KIND_REACTION],
        limit: REACTION_LIMIT,
      }),
    staleTime: 20_000,
  });
  const weights = useVoteWeights();
  const viewer = existingUserPubkey();
  const tallies = useMemo(
    () => tallyVotes(reactions.data ?? [], weights.data ?? (() => 1), viewer),
    [reactions.data, weights.data, viewer],
  );
  return { tallies, isLoading: reactions.isLoading };
}

/**
 * Every follow and unfollow in this tab, people and launches, one at a time (`lib/follow-queue.ts`). Lists are scoped
 * by server and person, so nothing written for one community or account is read back for another; switching
 * communities reloads the page, which starts this afresh.
 */
const listWriter = createListWriter({
  readLatest: async (write: ListWrite) =>
    latestList(
      await queryEvents(relayWsUrl(), {
        kinds: [write.kind],
        authors: [write.author],
        limit: 5,
      }),
      write.kind,
      write.author,
    ),
  publish: (template) =>
    publishAsUser(template, "The server refused this change to your follows."),
});

const listScope = (me: string) => `${relayWsUrl()}|${me}`;

/** The viewer's own follow (kind 3) and bookmark (kind 10003) lists. */
export function useMyLists() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: feedKeys.lists(me ?? ""),
    enabled: Boolean(me),
    queryFn: async () => {
      const author = me as string;
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_CONTACT_LIST, KIND_BOOKMARK_LIST],
        authors: [author],
        limit: 20,
      });
      // A read that started before one of this tab's follows landed must not bring the older list back.
      const scope = listScope(author);
      return {
        contacts: listWriter.newest(
          scope,
          KIND_CONTACT_LIST,
          latestList(events, KIND_CONTACT_LIST, author),
        ),
        bookmarks: listWriter.newest(
          scope,
          KIND_BOOKMARK_LIST,
          latestList(events, KIND_BOOKMARK_LIST, author),
        ),
      };
    },
    staleTime: 60_000,
  });
}

/** What is followed: a person (by key) or a launch (by coordinate). */
export type FollowTarget = { person: string } | { launchCoord: string };
export type FollowChange = FollowTarget & { follow: boolean };

const changeTarget = (what: FollowTarget) =>
  "person" in what
    ? { kind: KIND_CONTACT_LIST, target: what.person.toLowerCase() }
    : { kind: KIND_BOOKMARK_LIST, target: what.launchCoord };

/**
 * Follow or unfollow through the shared queue. `pendingFor` is the state a change is waiting for (shown on the button
 * meanwhile), or undefined. `change` resolves with the written list once the server accepted it, and rejects, with the
 * list left as it was, when it did not.
 */
export function useFollowChanges() {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  useSyncExternalStore(listWriter.subscribe, listWriter.version);

  const pendingFor = (what: FollowTarget) => {
    if (!me) return undefined;
    const { kind, target } = changeTarget(what);
    return listWriter.pendingFor(listScope(me), kind, target);
  };

  const change = useCallback(
    (next: FollowChange): Promise<SignedEventLike> => {
      if (!me) return Promise.reject(new Error("Sign in to follow."));
      const { kind, target } = changeTarget(next);
      return listWriter
        .enqueue({
          scope: listScope(me),
          author: me,
          kind,
          target,
          follow: next.follow,
          apply: (latest) =>
            kind === KIND_CONTACT_LIST
              ? withPerson(latest, target, next.follow)
              : withLaunch(latest, target, next.follow),
          onWritten: (written) => {
            queryClient.setQueryData<{
              contacts: SignedEventLike | null;
              bookmarks: SignedEventLike | null;
            }>(feedKeys.lists(me), (old) =>
              old === undefined
                ? old
                : kind === KIND_CONTACT_LIST
                  ? { ...old, contacts: written }
                  : { ...old, bookmarks: written },
            );
            if (kind === KIND_CONTACT_LIST) {
              // Who you follow and their follower counts, shown on profiles and in Explore.
              void queryClient.invalidateQueries({
                queryKey: ["social", "lists"],
              });
            }
          },
        })
        .catch((error: unknown) => {
          // The write may have landed even though no answer came: read the truth again.
          void queryClient.invalidateQueries({ queryKey: feedKeys.lists(me) });
          throw error;
        });
    },
    [me, queryClient],
  );

  return { pendingFor, change };
}

/**
 * Sign and publish to the community's relay; then, when the person turned it
 * on, copy a post or vote to their NIP-65 outbox relays. The copy is
 * best-effort: one bounded attempt per relay on its own socket, failures
 * logged and dropped. The community relay is the record — and the only copy
 * `useVoteTallies` counts — so a mirror never blocks or fails a publish.
 */
async function mirrorToOutbox(signed: NostrEvent): Promise<void> {
  let relayList: NostrEvent | null = null;
  try {
    const lists = await queryEvents(relayWsUrl(), {
      kinds: [KIND_RELAY_LIST],
      authors: [signed.pubkey],
      limit: 1,
    });
    relayList = lists[0] ?? null;
  } catch {
    relayList = null; // No list readable: the public defaults stand in.
  }
  for (const relay of outboxRelays(relayList)) {
    await withTimeout(
      publishEvent(relay, signed, { signAuth: signAsUser }),
      MIRROR_TIMEOUT_MS,
      `mirror to ${relay}`,
    ).catch((error) => {
      console.info("[feed] mirror skipped", relay, String(error));
    });
  }
}

export async function publishFeedEvent(
  template: EventTemplate,
): Promise<NostrEvent> {
  const signed = await publishAsUser(template, "The server refused this post.");
  if (readMirrorSetting() && isMirrorable(signed)) {
    void mirrorToOutbox(signed);
  }
  return signed;
}

/** The chain head, for filters that are true only at a block height. */
export function useChainBlockHeight(): bigint | null {
  const height = useQuery({
    queryKey: ["chain", "block-height"],
    queryFn: () => ethBlockNumber(getRpcEndpoint()),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return height.data ?? null;
}

/** Publish a note, vote or list and refresh what it affects. */
export function usePublishFeedEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishFeedEvent,
    onSuccess: (event) => {
      if (event.kind === KIND_REACTION) {
        void queryClient.invalidateQueries({ queryKey: feedKeys.reactions });
      } else if (
        event.kind === KIND_CONTACT_LIST ||
        event.kind === KIND_BOOKMARK_LIST
      ) {
        void queryClient.invalidateQueries({ queryKey: ["feed", "lists"] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ["feed"] });
      }
    },
  });
}
