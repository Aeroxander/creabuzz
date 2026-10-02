import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";

import { existingUserPubkey } from "@/shared/lib/identity";

import { launchCoordinate } from "../../feed/lib/feed-events";
import { useLaunches } from "../../launchpad/use-launches";
import type { Row } from "../lib/timeline";
import { useLaunchUpdates } from "../use-launch-updates";
import { engagementOf, useEngagementMap, usePeople } from "../use-people";
import { useBookmarkIds, useMutedPeople } from "../use-social-actions";
import { PostCard } from "./PostCard";
import { TimelineSkeleton } from "./Status";

/** Launch coordinate → launch name, so a post about a launch names it. */
function useLaunchName(): (coord: string) => string | null {
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

/**
 * Posts with everything a card needs resolved in batches: authors' profiles,
 * engagement counts, which are bookmarked, and who you muted (hidden). Calls
 * `onLoadMore` as the end of the list scrolls into view.
 */
export function PostList({
  rows,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  rows: readonly Row[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const me = existingUserPubkey();
  const mutedQuery = useMutedPeople();
  const muted = mutedQuery.data;
  const bookmarks = useBookmarkIds().data;
  const launchName = useLaunchName();
  const officialUpdates = useLaunchUpdates().ids;

  const visible = useMemo(
    () =>
      muted?.size
        ? rows.filter(
            (r) =>
              !muted.has(r.event.pubkey) &&
              !(r.repostedBy && muted.has(r.repostedBy.pubkey)),
          )
        : rows,
    [rows, muted],
  );
  const people = usePeople(
    useMemo(
      () =>
        visible.flatMap((r) =>
          r.repostedBy
            ? [r.event.pubkey, r.repostedBy.pubkey]
            : [r.event.pubkey],
        ),
      [visible],
    ),
  );
  const engagement = useEngagementMap(
    useMemo(() => visible.map((r) => r.event.id), [visible]),
    me,
  );

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && onLoadMore(),
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  // Until the mute list is known a muted person's post would flash and then
  // vanish, so signed-in readers see the loading state instead.
  if (me && mutedQuery.isLoading) return <TimelineSkeleton />;

  return (
    <div data-testid="social-post-list">
      {visible.map((row) => (
        <PostCard
          author={people[row.event.pubkey]}
          bookmarked={bookmarks?.includes(row.event.id) ?? false}
          engagement={engagementOf(engagement, row.event.id)}
          key={`${row.event.id}:${row.repostedBy?.pubkey ?? ""}`}
          launchName={launchName}
          launchUpdate={officialUpdates.has(row.event.id)}
          reposter={row.repostedBy ? people[row.repostedBy.pubkey] : undefined}
          row={row}
        />
      ))}
      <div className="flex h-14 items-center justify-center" ref={sentinel}>
        {loadingMore ? (
          <Loader2
            aria-label="Loading more"
            className="h-5 w-5 animate-spin text-black/50 dark:text-white/50"
          />
        ) : null}
      </div>
    </div>
  );
}
