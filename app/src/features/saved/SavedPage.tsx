import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { Bookmark } from "lucide-react";
import { BackHeader } from "../../app/BackHeader";
import { useBookmarks } from "../../lib/bookmarks";
import { useAccount } from "../../lib/account";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { PostList } from "../posts/PostList";
import { HIDES_UNKNOWN } from "../room/room-words";
import { useVisiblePosts } from "../safety/use-hidden";
import {
  SAVED_EMPTY,
  SAVED_EMPTY_TITLE,
  SAVED_POSTS_FAILED,
  SAVED_PRIVATE,
  SAVED_READ_FAILED,
  SAVED_SIGNED_OUT_TITLE,
  SAVED_TITLE,
  savedGone,
  savedHidden,
  savedMore,
} from "./saved-words";
import { SAVED_SHOWN, useSavedPosts } from "./use-saved-posts";

/** The posts this person saved, newest save first. The list is private: nobody else can read what is in it. */
export function SavedPage() {
  const { pubkey } = useAccount();
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-4"
      data-testid="saved-page"
    >
      <BackHeader title={SAVED_TITLE} />
      {pubkey ? (
        <Saved />
      ) : (
        <EmptyState
          action={
            <ButtonLink to="/welcome" variant="secondary">
              Make your account
            </ButtonLink>
          }
          title={SAVED_SIGNED_OUT_TITLE}
        >
          Saved posts belong to your account.
        </EmptyState>
      )}
    </main>
  );
}

function Saved() {
  const bookmarks = useBookmarks();
  const posts = useSavedPosts(bookmarks.ids);
  const visible = useVisiblePosts(posts.data);
  const asked = Math.min(bookmarks.ids.length, SAVED_SHOWN);

  if (bookmarks.failed)
    return (
      <EmptyState
        action={
          <Button onClick={() => void bookmarks.refetch()} variant="secondary">
            Try again
          </Button>
        }
        testId="saved-unreadable"
        title={SAVED_READ_FAILED}
      >
        If your passkey is locked, unlock it first. Your saved posts are not
        lost.
      </EmptyState>
    );
  if (
    !bookmarks.ready ||
    !visible.ready ||
    (bookmarks.ids.length > 0 && posts.isPending)
  )
    return (
      <Card
        className="h-24 animate-pulse"
        data-testid="saved-loading"
        tone="plain"
      />
    );
  if (bookmarks.ids.length === 0)
    return (
      <>
        <p className="px-1 text-sm text-muted">{SAVED_PRIVATE}</p>
        <EmptyState
          icon={<Bookmark size={28} />}
          testId="saved-empty"
          title={SAVED_EMPTY_TITLE}
        >
          {SAVED_EMPTY}
        </EmptyState>
      </>
    );
  if (posts.isError)
    return (
      <EmptyState
        action={
          <Button onClick={() => void posts.refetch()} variant="secondary">
            Try again
          </Button>
        }
        testId="saved-read-failed"
        title={SAVED_POSTS_FAILED}
      >
        {readFailureWords(posts.error).text}
      </EmptyState>
    );
  const gone = asked - (posts.data?.length ?? 0);
  return (
    <>
      <p className="px-1 text-sm text-muted">{SAVED_PRIVATE}</p>
      {visible.unknown ? (
        <p
          className="px-1 text-sm text-muted"
          data-testid="saved-hides-unknown"
        >
          {HIDES_UNKNOWN}
        </p>
      ) : null}
      {visible.shown.length > 0 ? (
        <PostList events={visible.shown} testId="saved-list" />
      ) : null}
      {visible.hidden > 0 ? (
        <p className="px-1 text-sm text-muted" data-testid="saved-hidden">
          {savedHidden(visible.hidden)}
        </p>
      ) : null}
      {gone > 0 ? (
        <p className="px-1 text-sm text-muted" data-testid="saved-gone">
          {savedGone(gone)}
        </p>
      ) : null}
      {bookmarks.ids.length > SAVED_SHOWN ? (
        <p className="px-1 text-sm text-muted">{savedMore(SAVED_SHOWN)}</p>
      ) : null}
    </>
  );
}
