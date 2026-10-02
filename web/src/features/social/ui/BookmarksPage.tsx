import { existingUserPubkey } from "@/shared/lib/identity";

import { useBookmarkIds } from "../use-social-actions";
import { useNotesById } from "../use-social-data";
import { PostList } from "./PostList";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

/** Posts you saved. Only you can see this list. */
export function BookmarksPage() {
  const me = existingUserPubkey();
  const ids = useBookmarkIds();
  // Newest save first.
  const notes = useNotesById([...(ids.data ?? [])].reverse());

  return (
    <SocialShell>
      <PageBar title="Bookmarks" />
      {!me ? (
        <EmptyState title="Sign in to save posts">
          Bookmarks are private to you.
        </EmptyState>
      ) : ids.isLoading || (ids.data?.length && notes.isLoading) ? (
        <TimelineSkeleton />
      ) : !notes.data?.length ? (
        <EmptyState
          testId="social-bookmarks-empty"
          title="Save posts for later"
        >
          Bookmark a post to find it here. Only you can see your bookmarks.
        </EmptyState>
      ) : (
        <PostList rows={notes.data} />
      )}
    </SocialShell>
  );
}
