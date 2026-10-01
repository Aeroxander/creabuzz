import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

import type { Post } from "../feed-model";
import { usePostMeta, useProfiles } from "../use-feed";
import { useBookmarks, useMuted } from "../use-social";
import { PostRow } from "./PostRow";

function PostSkeleton() {
  return (
    <div className="flex gap-3 border-b px-4 py-3">
      <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-foreground/10" />
      <div className="flex-1 space-y-2 pt-1">
        <div className="h-4 w-40 animate-pulse rounded bg-foreground/10" />
        <div className="h-4 w-full animate-pulse rounded bg-foreground/10" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-foreground/10" />
      </div>
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <>
      {["a", "b", "c", "d"].map((k) => (
        <PostSkeleton key={k} />
      ))}
    </>
  );
}

/** Rows plus the batched profile/meta lookups, with optional infinite scroll. */
export function PostList({
  posts,
  viewer,
  hasMore,
  isFetchingMore,
  onLoadMore,
}: {
  posts: Post[];
  viewer: string | null;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const muted = useMuted(viewer).data;
  const bookmarks = useBookmarks(viewer).data;
  const visible = muted?.length
    ? posts.filter((p) => !muted.includes(p.event.pubkey))
    : posts;
  const profiles = useProfiles(
    visible.flatMap((p) =>
      p.repostedBy ? [p.event.pubkey, p.repostedBy.pubkey] : [p.event.pubkey],
    ),
  );
  const meta = usePostMeta(
    visible.map((p) => p.event.id),
    viewer,
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

  return (
    <>
      {visible.map((post) => (
        <PostRow
          key={`${post.event.id}:${post.repostedBy?.pubkey ?? ""}`}
          post={post}
          reposterProfile={
            post.repostedBy
              ? profiles.data?.get(post.repostedBy.pubkey)
              : undefined
          }
          bookmarked={bookmarks?.includes(post.event.id) ?? false}
          profile={profiles.data?.get(post.event.pubkey)}
          meta={meta.data?.get(post.event.id)}
          viewer={viewer}
        />
      ))}
      <div ref={sentinel} className="flex h-16 items-center justify-center">
        {isFetchingMore && (
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        )}
      </div>
    </>
  );
}
