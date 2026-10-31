import { useMemo } from "react";

import { useBoardPostsById } from "@/features/board/use-board-posts-by-id";
import { existingUserPubkey } from "@/shared/lib/identity";

import type { TimelineItem } from "../lib/mixed-timeline";
import { activityAt } from "../lib/timeline";
import { useBookmarkIds } from "../use-social-actions";
import { useNotesById } from "../use-social-data";
import { PostList } from "./PostList";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

/** Posts and board posts you saved, newest save first. Only you can see this list. */
export function BookmarksPage() {
  const me = existingUserPubkey();
  const ids = useBookmarkIds();
  // Newest save first.
  const order = useMemo(() => [...(ids.data ?? [])].reverse(), [ids.data]);
  const notes = useNotesById(order);
  const boardPosts = useBoardPostsById(order);

  const items = useMemo<TimelineItem[]>(() => {
    const noteById = new Map(
      (notes.data ?? []).map((row) => [row.event.id, row]),
    );
    const postById = new Map(boardPosts.posts.map((post) => [post.id, post]));
    return order.flatMap((id): TimelineItem[] => {
      const row = noteById.get(id);
      if (row)
        return [{ kind: "note", key: `n:${id}`, row, at: activityAt(row) }];
      const post = postById.get(id);
      return post
        ? [{ kind: "board", key: `b:${id}`, post, at: post.createdAt }]
        : [];
    });
  }, [order, notes.data, boardPosts.posts]);

  return (
    <SocialShell>
      <PageBar title="Bookmarks" />
      {!me ? (
        <EmptyState title="Sign in to save posts">
          Bookmarks are private to you.
        </EmptyState>
      ) : ids.isLoading ||
        (order.length > 0 && (notes.isLoading || boardPosts.isLoading)) ? (
        <TimelineSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          testId="social-bookmarks-empty"
          title="Save posts for later"
        >
          Bookmark a post to find it here. Only you can see your bookmarks.
        </EmptyState>
      ) : (
        <PostList
          boards={{ names: boardPosts.names, add: boardPosts.add }}
          items={items}
        />
      )}
    </SocialShell>
  );
}
