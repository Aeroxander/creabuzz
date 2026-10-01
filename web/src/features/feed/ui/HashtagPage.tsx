import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { useTimeline, useViewerPubkey } from "../use-feed";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { PostList, TimelineSkeleton } from "./Timeline";

export function HashtagPage() {
  const { tag } = useParams({ from: "/tag/$tag" });
  const viewer = useViewerPubkey();
  const lower = tag.toLowerCase();
  const timeline = useTimeline({
    key: ["tag", lower],
    filter: { "#t": [lower] },
    select: () => true,
  });
  const posts = timeline.data?.pages.flatMap((p) => p.posts) ?? [];

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 flex h-[53px] items-center gap-6 border-b bg-background/85 px-4 backdrop-blur">
        <Link
          to="/feed"
          aria-label="Back to feed"
          className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-foreground/10"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="truncate text-xl font-bold">#{lower}</h1>
      </div>
      {timeline.isLoading ? (
        <TimelineSkeleton />
      ) : timeline.isError ? (
        <Message title="Something went wrong" body={timeline.error.message} />
      ) : posts.length === 0 ? (
        <Message
          title={`Nothing for #${lower} yet`}
          body="Be the first to post with this hashtag."
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
