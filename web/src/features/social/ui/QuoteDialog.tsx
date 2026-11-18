import { useEffect, useRef } from "react";

import { UserAvatar } from "@/shared/ui/UserAvatar";

import type { SignedEventLike } from "../../feed/lib/feed-events";
import { avatarName, bylineName } from "../lib/person-name";
import { usePeople } from "../use-people";
import { PostContent } from "./PostContent";
import { PostComposer } from "./PostComposer";

/**
 * A native dialog holding the quote-post composer over the post being quoted: a title, a way out, and the quoted post
 * as a small card with its author, so it is clear whose words are being quoted.
 */
export function QuoteDialog({
  open,
  onClose,
  note,
}: {
  open: boolean;
  onClose: () => void;
  note: SignedEventLike;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-labelledby="social-quote-title"
      className="m-auto max-h-[90dvh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl glass-dialog border p-0 text-foreground backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      data-testid="social-quote-dialog"
      onClose={onClose}
      ref={ref}
    >
      {open ? (
        <>
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <h2 className="text-base font-bold" id="social-quote-title">
              Quote post
            </h2>
            <button
              className="rounded-full px-3 py-1 text-sm font-medium text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
              data-testid="social-quote-cancel"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
          </div>
          <PostComposer
            autoFocus
            onPosted={onClose}
            placeholder="Add a comment"
            quote={note}
            testId="social-quote-composer"
          />
          <QuotedPost note={note} />
        </>
      ) : null}
    </dialog>
  );
}

function QuotedPost({ note }: { note: SignedEventLike }) {
  const author = usePeople([note.pubkey])[note.pubkey];
  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className="rounded-xl border border-black/10 p-3 text-sm dark:border-white/10"
        data-testid="social-quote-original"
      >
        <p className="mb-1 flex items-center gap-2">
          <UserAvatar
            avatarUrl={author?.picture ?? null}
            displayName={avatarName(author)}
            size="xs"
          />
          <span className="truncate font-semibold">{bylineName(author)}</span>
        </p>
        {/* Four lines and an ellipsis: enough to know which post it is, with no box to scroll and no line cut in half. */}
        <div className="line-clamp-4" data-testid="social-quote-original-text">
          <PostContent embed={false} text={note.content} />
        </div>
      </div>
    </div>
  );
}
