import { useState } from "react";

import { cn } from "@/shared/lib/cn";
import { hasNip07Provider } from "@/shared/lib/nostr-signer";
import {
  isFeedPreview,
  useFollows,
  useProfiles,
  useTimeline,
  useViewerPubkey,
} from "../use-feed";
import { Composer } from "./Composer";
import { FeedShell } from "./FeedShell";
import { PostList, TimelineSkeleton } from "./Timeline";

type Tab = "for-you" | "following";

function Tabs({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: "for-you", label: "For you" },
    { id: "following", label: "Following" },
  ];
  return (
    <div role="tablist" className="flex">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          onClick={() => onChange(item.id)}
          className="relative flex h-[53px] flex-1 items-center justify-center text-[15px] transition-colors hover:bg-foreground/5"
        >
          <span
            className={cn(
              "relative flex h-full items-center",
              tab === item.id
                ? "font-bold"
                : "font-medium text-muted-foreground",
            )}
          >
            {item.label}
            {tab === item.id && (
              <span className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-primary" />
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-sm px-8 py-16 text-center">
      <h2 className="text-3xl font-extrabold">{title}</h2>
      <p className="mt-2 text-[15px] text-muted-foreground">{body}</p>
    </div>
  );
}

export function FeedHomePage() {
  const [tab, setTab] = useState<Tab>("for-you");
  const viewer = useViewerPubkey();
  const follows = useFollows(viewer);
  const viewerProfile = useProfiles(viewer ? [viewer] : []).data?.get(
    viewer ?? "",
  );

  const followList =
    tab === "following"
      ? [...(follows.data ?? []), ...(viewer ? [viewer] : [])]
      : null;
  const timeline = useTimeline(followList);
  const posts = timeline.data?.pages.flatMap((p) => p.posts) ?? [];
  const followingBlocked =
    tab === "following" && !viewer && !isFeedPreview() && !hasNip07Provider();

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <h1 className="sr-only">Home</h1>
        <Tabs tab={tab} onChange={setTab} />
      </div>
      <Composer viewer={viewer} profile={viewerProfile} />

      {followingBlocked ? (
        <Message
          title="Connect to see your following feed"
          body="Sign in with a Nostr browser extension to see posts from people you follow."
        />
      ) : timeline.isLoading || (tab === "following" && follows.isLoading) ? (
        <TimelineSkeleton />
      ) : timeline.isError ? (
        <Message title="Something went wrong" body={timeline.error.message} />
      ) : posts.length === 0 ? (
        <Message
          title={
            tab === "following" ? "Nothing here yet" : "Welcome to the feed"
          }
          body={
            tab === "following"
              ? "Posts from people you follow will show up here."
              : "No posts yet. Be the first to say something."
          }
        />
      ) : (
        <PostList
          posts={posts}
          viewer={viewer}
          hasMore={timeline.hasNextPage}
          isFetchingMore={timeline.isFetchingNextPage}
          onLoadMore={() => {
            if (!timeline.isFetchingNextPage) timeline.fetchNextPage();
          }}
        />
      )}
    </FeedShell>
  );
}
