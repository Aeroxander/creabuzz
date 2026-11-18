import {
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@creaton/core/kinds.ts";
import {
  computeEngagement,
  type Engagement,
  NO_ENGAGEMENT,
} from "@creaton/core/social/engagement.ts";
import {
  buildPost,
  buildReply,
  buildVote,
  type LaunchRef,
  parseNote,
} from "@creaton/core/social/feed/feed-events.ts";
import { fetchThread } from "@creaton/core/social/thread-read.ts";
import type { Row, SignedEvent } from "@creaton/core/social/timeline.ts";
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "../../lib/account";
import { type NostrEvent, publishAsUser, read } from "../../lib/relay";

export type { Engagement, Row, SignedEvent };

const postKeys = {
  all: ["posts"] as const,
  recent: (authors: readonly string[] | null) =>
    ["posts", "recent", authors?.join(",") ?? "everyone"] as const,
  thread: (id: string) => ["posts", "thread", id] as const,
  engagement: (ids: readonly string[], viewer: string | null) =>
    ["posts", "engagement", viewer, ...ids] as const,
  by: (author: string) => ["posts", "by", author] as const,
};

const RECENT_LIMIT = 40;

/** Top-level posts only: replies live under their post. */
function topLevel(events: readonly NostrEvent[]): NostrEvent[] {
  return events.filter((event) => parseNote(event)?.rootId === null);
}

/** The newest top-level posts, by `authors` when given (people you follow), otherwise by everyone. */
export function useRecentPosts(authors: readonly string[] | null) {
  return useQuery({
    queryKey: postKeys.recent(authors),
    staleTime: 15_000,
    queryFn: async () =>
      topLevel(
        await read({
          kinds: [KIND_TEXT_NOTE],
          ...(authors && authors.length > 0 ? { authors: [...authors] } : {}),
          limit: RECENT_LIMIT,
        }),
      ),
  });
}

/** A person's own top-level posts, for their profile. */
export function usePostsBy(author: string) {
  return useQuery({
    queryKey: postKeys.by(author),
    staleTime: 15_000,
    queryFn: async () =>
      topLevel(
        await read({ kinds: [KIND_TEXT_NOTE], authors: [author], limit: 30 }),
      ),
  });
}

/** Votes, reposts and replies on the posts on screen, with the viewer's own vote; one read for all of them. */
export function useEngagement(ids: readonly string[]) {
  const { pubkey } = useAccount();
  const sorted = [...ids].sort();
  return useQuery({
    queryKey: postKeys.engagement(sorted, pubkey),
    enabled: sorted.length > 0,
    staleTime: 15_000,
    queryFn: async () =>
      computeEngagement(
        sorted,
        await read({
          kinds: [KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE],
          "#e": sorted,
          limit: 500,
        }),
        pubkey,
      ),
  });
}

export function engagementOf(
  map: Map<string, Engagement> | undefined,
  id: string,
): Engagement {
  return map?.get(id) ?? NO_ENGAGEMENT;
}

/** A post, the posts above it and every reply in its conversation. */
export function useThread(id: string) {
  return useQuery({
    queryKey: postKeys.thread(id),
    staleTime: 10_000,
    queryFn: () => fetchThread(relayWsUrl(), id),
  });
}

/** Write a post, about a project when one is given. */
export function usePublishPost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; launch?: LaunchRef | null }) =>
      publishAsUser(buildPost(input), "Your post was not sent. Try again."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: postKeys.all }),
  });
}

/** Answer a post or a reply in its thread. */
export function usePublishReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      text: string;
      root: SignedEvent;
      parent: SignedEvent;
    }) =>
      publishAsUser(buildReply(input), "Your reply was not sent. Try again."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: postKeys.all }),
  });
}

/** An up vote (a like). */
export function useLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: SignedEvent) =>
      publishAsUser(
        buildVote({ target, direction: "+" }),
        "Your like was not sent. Try again.",
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["posts", "engagement"] }),
  });
}
