import { useMemo } from "react";

import { KIND_FORUM_POST } from "@/features/board/lib/board-events";
import { useBoardPostsById } from "@/features/board/use-board-posts-by-id";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import type { TimelineItem } from "../lib/mixed-timeline";
import { firstError, listView, partialError } from "../lib/read-view";
import { activityAt } from "../lib/timeline";
import { useBookmarkIds } from "../use-bookmarks";
import { useNotesById } from "../use-social-data";
import { PostList } from "./PostList";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, PartialFailure, TimelineSkeleton } from "./Status";

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
  const error = firstError(ids.error, notes.error, boardPosts.error);
  const view = listView({
    count: items.length,
    error,
    loading:
      ids.isLoading ||
      (order.length > 0 && (notes.isLoading || boardPosts.isLoading)),
  });

  const retry = () => {
    void ids.refetch();
    if (notes.error) void notes.refetch();
    if (boardPosts.error) boardPosts.refetch();
  };

  return (
    <SocialShell>
      <PageBar title="Bookmarks" />
      {!me ? (
        <EmptyState title="Sign in to save posts">
          Bookmarks are private to you.
        </EmptyState>
      ) : view === "loading" ? (
        <TimelineSkeleton />
      ) : view === "error" ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer, so your saved posts can't be shown. Nothing was lost."
            error={error}
            kinds={
              boardPosts.error
                ? [KIND_TEXT_NOTE, KIND_FORUM_POST]
                : [KIND_TEXT_NOTE]
            }
            onRetry={retry}
            relayUrl={relayWsUrl()}
            testId="social-bookmarks-error"
            title="Couldn't load your bookmarks"
          />
        </div>
      ) : view === "empty" ? (
        <EmptyState
          testId="social-bookmarks-empty"
          title="Save posts for later"
        >
          Bookmark a post to find it here. Only you can see your bookmarks.
        </EmptyState>
      ) : (
        <>
          {partialError(view, error) ? (
            <PartialFailure
              onRetry={retry}
              testId="social-bookmarks-partial-error"
            >
              Some of your saved posts couldn't be loaded, so this list may not
              be complete. Nothing was lost.
            </PartialFailure>
          ) : null}
          <PostList
            boards={{ names: boardPosts.names, add: boardPosts.add }}
            items={items}
          />
        </>
      )}
    </SocialShell>
  );
}
