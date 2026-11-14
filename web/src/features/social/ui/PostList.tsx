import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { failureWords } from "@/shared/lib/readable-error";

import { BoardPostCard } from "../../board/ui/BoardPostCard";
import type { BoardEvent } from "../../board/lib/board-model";
import { launchCoordinate } from "../../feed/lib/feed-events";
import { useLaunches } from "../../launchpad/use-launches";
import type { TimelineItem } from "../lib/mixed-timeline";
import { moreState } from "../lib/read-view";
import { activityAt, type Row } from "../lib/timeline";
import { useLaunchUpdates } from "../use-launch-updates";
import { engagementOf, useEngagementMap, usePeople } from "../use-people";
import { useBookmarkIds } from "../use-bookmarks";
import { useMutedPeople } from "../use-social-actions";
import { LastVisitLine } from "./HomeFreshParts";
import { PostCard } from "./PostCard";
import { TimelineSkeleton } from "./Status";

/** Launch coordinate → launch name, so a post about a launch names it. */
export function useLaunchName(): (coord: string) => string | null {
  const launches = useLaunches().data;
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const launch of launches ?? []) {
      map.set(
        launchCoordinate({
          pubkey: launch.record.author,
          id: launch.record.id,
        }),
        launch.record.name,
      );
    }
    return map;
  }, [launches]);
  return (coord) => names.get(coord) ?? null;
}

/** Board posts in a mixed timeline: their boards' names, and where a vote the server accepted goes. */
export interface BoardContext {
  names: ReadonlyMap<string, { name: string }>;
  add: (event: BoardEvent) => void;
}

/**
 * Posts with everything a card needs resolved in batches: authors' profiles,
 * engagement counts, which are bookmarked, and who you muted (hidden). Calls
 * `onLoadMore` as the end of the list scrolls into view; when an older page failed (`loadMoreError`) it stops asking and
 * says so, with a "Try again" that calls `onLoadMore`.
 *
 * Takes plain note rows, or a mixed timeline (`items`) of notes and board posts with the `boards` they need.
 */
export function PostList({
  rows,
  items,
  boards,
  hasMore = false,
  loadingMore = false,
  loadMoreError = null,
  onLoadMore,
  lastVisitBefore = null,
}: {
  rows?: readonly Row[];
  items?: readonly TimelineItem[];
  boards?: BoardContext;
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Why the last older page failed, or null. */
  loadMoreError?: unknown;
  onLoadMore?: () => void;
  /** Home: the item the "New since your last visit" line goes above. */
  lastVisitBefore?: string | null;
}) {
  const me = existingUserPubkey();
  const mutedQuery = useMutedPeople();
  const muted = mutedQuery.data;
  const bookmarks = useBookmarkIds().data;
  const launchName = useLaunchName();
  const officialUpdates = useLaunchUpdates().ids;

  const all = useMemo<readonly TimelineItem[]>(
    () =>
      items ??
      (rows ?? []).map((row) => ({
        kind: "note" as const,
        key: `n:${row.event.id}:${row.repostedBy?.pubkey ?? ""}`,
        row,
        at: activityAt(row),
      })),
    [items, rows],
  );
  const visible = useMemo(
    () =>
      muted?.size
        ? all.filter((item) =>
            item.kind === "board"
              ? !muted.has(item.post.author)
              : !muted.has(item.row.event.pubkey) &&
                !(item.row.repostedBy && muted.has(item.row.repostedBy.pubkey)),
          )
        : all,
    [all, muted],
  );
  const people = usePeople(
    useMemo(
      () =>
        visible.flatMap((item) =>
          item.kind === "board"
            ? [item.post.author]
            : item.row.repostedBy
              ? [item.row.event.pubkey, item.row.repostedBy.pubkey]
              : [item.row.event.pubkey],
        ),
      [visible],
    ),
  );
  const engagement = useEngagementMap(
    useMemo(
      () =>
        visible.flatMap((item) =>
          item.kind === "note" ? [item.row.event.id] : [],
        ),
      [visible],
    ),
    me,
  );

  const more = moreState({
    hasMore,
    loadingMore,
    failed: Boolean(loadMoreError),
  });
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || more !== "idle" || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && onLoadMore(),
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, onLoadMore]);

  // Until the mute list is known a muted person's post would flash and then
  // vanish, so signed-in readers see the loading state instead.
  if (me && mutedQuery.isLoading) return <TimelineSkeleton />;

  return (
    <div data-testid="social-post-list">
      {visible.flatMap((item) => [
        item.key === lastVisitBefore ? (
          <LastVisitLine key="last-visit" />
        ) : null,
        item.kind === "board" ? (
          boards ? (
            <BoardPostCard
              add={boards.add}
              author={people[item.post.author]}
              bookmarked={bookmarks?.includes(item.post.id) ?? false}
              board={{
                id: item.post.boardId,
                name: boards.names.get(item.post.boardId)?.name ?? "Board",
              }}
              key={item.key}
              post={item.post}
            />
          ) : null
        ) : (
          <PostCard
            author={people[item.row.event.pubkey]}
            bookmarked={bookmarks?.includes(item.row.event.id) ?? false}
            engagement={engagementOf(engagement, item.row.event.id)}
            key={item.key}
            launchName={launchName}
            launchUpdate={officialUpdates.has(item.row.event.id)}
            reposter={
              item.row.repostedBy
                ? people[item.row.repostedBy.pubkey]
                : undefined
            }
            row={item.row}
          />
        ),
      ])}
      <div
        className="flex min-h-14 items-center justify-center py-2"
        ref={sentinel}
      >
        {more === "loading" ? (
          <Loader2
            aria-label="Loading more"
            className="h-5 w-5 animate-spin text-black/50 dark:text-white/50"
          />
        ) : more === "failed" ? (
          <p
            className="px-4 text-center text-xs text-amber-700 dark:text-amber-300"
            data-testid="social-load-more-error"
            role="alert"
          >
            Couldn't load older posts.{" "}
            {
              failureWords(
                loadMoreError,
                "The server didn't answer. What's above is still here.",
              ).text
            }{" "}
            {onLoadMore ? (
              <button
                className="font-semibold underline"
                data-testid="social-load-more-retry"
                onClick={onLoadMore}
                type="button"
              >
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
