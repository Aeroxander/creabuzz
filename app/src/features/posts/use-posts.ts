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
  buildReply,
  buildVote,
  inAnyRoom,
  type LaunchRef,
  parseNote,
  type RoomRef,
} from "@creaton/core/social/feed/feed-events.ts";
import {
  buildComposedPost,
  type QuoteRef,
} from "@creaton/core/social/post-compose.ts";
import type { PostPicture } from "@creaton/core/social/pictures.ts";
import { buildRepost, buildUndo } from "@creaton/core/social/post-events.ts";
import { fetchThread } from "@creaton/core/social/thread-read.ts";
import {
  buildRows,
  repostTargetIds,
  type Row,
  type SignedEvent,
} from "@creaton/core/social/timeline.ts";
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

/**
 * Top-level posts only: replies live under their post. A holder room's posts are never here: the room is read in its own tab,
 * by its tag, and what is said there is not in Home, a profile or a project's updates.
 */
function topLevel(events: readonly NostrEvent[]): NostrEvent[] {
  return events.filter(
    (event) => parseNote(event)?.rootId === null && !inAnyRoom(event),
  );
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

const REPOST_LIMIT = 20;

/**
 * The newest reposts by `authors` (everyone when null) and the posts they share, which the server answers for itself: a
 * repost carries a copy of the post, but the copy outlives the post, so a repost of a post its author deleted is never shown.
 */
export function useReposts(authors: readonly string[] | null) {
  return useQuery({
    queryKey: ["posts", "reposts", authors?.join(",") ?? "everyone"] as const,
    staleTime: 15_000,
    queryFn: async () => {
      const reposts = await read({
        kinds: [KIND_REPOST],
        ...(authors && authors.length > 0 ? { authors: [...authors] } : {}),
        limit: REPOST_LIMIT,
      });
      const ids = repostTargetIds(reposts as SignedEvent[]);
      const originals =
        ids.length > 0
          ? await read({ ids, kinds: [KIND_TEXT_NOTE], limit: ids.length })
          : [];
      return { reposts, originals };
    },
  });
}

/**
 * Home's rows: the newest posts and the reposts of posts, newest activity first, each post once (at its newest). A repost
 * of a reply, or of a post in a holder room, is left out, as those posts are everywhere.
 */
export function feedRows(
  posts: readonly NostrEvent[] | undefined,
  reposted: { reposts: NostrEvent[]; originals: NostrEvent[] } | undefined,
): Row[] {
  return buildRows(
    [...(posts ?? []), ...(reposted?.reposts ?? [])] as SignedEvent[],
    new Map((reposted?.originals ?? []).map((e) => [e.id, e as SignedEvent])),
  ).filter((row) => row.rootId === null && !inAnyRoom(row.event));
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
        // Anything from a room that names one of these posts is not counted: a room is counted in its own tab.
        (
          await read({
            kinds: [KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE],
            "#e": sorted,
            limit: 500,
          })
        ).filter((event) => !inAnyRoom(event)),
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

/** What a post that replaces another says when the old one could not be taken down (the new one is up). */
export const OLD_NOT_REMOVED =
  "Your changed post is up, but the old one could not be taken down. Delete the old one from its page.";

/**
 * Write a post with words, pictures, a project and a quote (the writing box), or an edited post: a post cannot be changed
 * once it is sent, so an edit sends the changed post first and then takes the old one down. If taking the old one down fails
 * the new post is still up and the answer says so, so neither is lost.
 */
export function usePublishComposed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      text: string;
      pictures: readonly PostPicture[];
      launch?: LaunchRef | null;
      quote?: QuoteRef | null;
      /** The post this one replaces (an edit). */
      replaces?: SignedEvent | null;
    }): Promise<{ oldRemoved: boolean }> => {
      await publishAsUser(
        buildComposedPost(input),
        "Your post was not sent. Try again.",
      );
      if (!input.replaces) return { oldRemoved: true };
      try {
        await publishAsUser(
          buildUndo(input.replaces.id, KIND_TEXT_NOTE),
          OLD_NOT_REMOVED,
        );
        return { oldRemoved: true };
      } catch {
        return { oldRemoved: false };
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: postKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["search", "posts"] });
    },
  });
}

/** Ask the server to stop showing one of the person's own posts (it is not deleted from copies others made). */
export function useDeletePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (post: SignedEvent) =>
      publishAsUser(
        buildUndo(post.id, post.kind),
        "Your post was not deleted. Try again.",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: postKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["search", "posts"] });
    },
  });
}

/** Share a post with the person's own followers, as it is (a repost), or take the repost back. */
export function useRepost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      post,
      undoId,
    }: {
      post: SignedEvent;
      /** The id of the person's own repost to take back; when given, the post is not shared again. */
      undoId?: string | null;
    }) =>
      publishAsUser(
        undoId ? buildUndo(undoId, KIND_REPOST) : buildRepost(post),
        undoId
          ? "Your repost was not taken back. Try again."
          : "Your repost was not sent. Try again.",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: postKeys.all });
    },
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
      room?: RoomRef | null;
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
