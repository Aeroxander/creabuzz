import { usePostsByIds, useViewerPubkey } from "../use-feed";
import { useBookmarks } from "../use-social";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { PostList, TimelineSkeleton } from "./Timeline";

export function BookmarksPage() {
  const viewer = useViewerPubkey();
  const bookmarks = useBookmarks(viewer);
  // Newest bookmark first.
  const ids = [...(bookmarks.data ?? [])].reverse();
  const posts = usePostsByIds(ids);

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 flex h-[53px] items-center border-b bg-background/85 px-4 backdrop-blur">
        <h1 className="text-xl font-bold">Bookmarks</h1>
      </div>
      {!viewer ? (
        <Message
          title="Sign in to see your bookmarks"
          body="Bookmarks are private to you."
        />
      ) : bookmarks.isLoading || posts.isLoading ? (
        <TimelineSkeleton />
      ) : !posts.data?.length ? (
        <Message
          title="Save posts for later"
          body="Bookmark a post to find it here. Only you can see your bookmarks."
        />
      ) : (
        <PostList posts={posts.data} viewer={viewer} />
      )}
    </FeedShell>
  );
}
