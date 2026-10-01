import { useState } from "react";

import { hasNip07Provider } from "@/shared/lib/nostr-signer";
import {
  isFeedPreview,
  useProfiles,
  useTimeline,
  useViewerPubkey,
} from "../use-feed";
import { useContacts } from "../use-social";
import { Composer } from "./Composer";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { TabBar } from "./TabBar";
import { PostList, TimelineSkeleton } from "./Timeline";

type Tab = "for-you" | "following";

const TABS: { id: Tab; label: string }[] = [
  { id: "for-you", label: "For you" },
  { id: "following", label: "Following" },
];

export function FeedHomePage() {
  const [tab, setTab] = useState<Tab>("for-you");
  const viewer = useViewerPubkey();
  const follows = useContacts(viewer);
  const viewerProfile = useProfiles(viewer ? [viewer] : []).data?.get(
    viewer ?? "",
  );

  const authors =
    tab === "following"
      ? [...(follows.data ?? []), ...(viewer ? [viewer] : [])]
      : null;
  const timeline = useTimeline({
    key: [tab, authors ? [...authors].sort() : "global"],
    authors,
    reposts: true,
  });
  const posts = timeline.data?.pages.flatMap((p) => p.posts) ?? [];
  const followingBlocked =
    tab === "following" && !viewer && !isFeedPreview() && !hasNip07Provider();

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <h1 className="sr-only">Home</h1>
        <TabBar tabs={TABS} value={tab} onChange={setTab} />
      </div>
      <Composer viewer={viewer} profile={viewerProfile} />

      {followingBlocked ? (
        <Message
          title="Sign in to see your following feed"
          body="Posts from people you follow will show up here."
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
