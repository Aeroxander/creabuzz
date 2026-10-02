import { useEffect, useRef } from "react";

import type { SignedEventLike } from "../../feed/lib/feed-events";
import { PostContent } from "./PostContent";
import { PostComposer } from "./PostComposer";

/** A native dialog holding the quote-post composer over the post being quoted. */
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
      aria-label="Quote post"
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl border border-black/10 bg-white p-0 text-black backdrop:bg-black/50 dark:border-white/15 dark:bg-neutral-900 dark:text-white"
      data-testid="social-quote-dialog"
      onClose={onClose}
      ref={ref}
    >
      {open ? (
        <>
          <PostComposer
            autoFocus
            onPosted={onClose}
            placeholder="Add a comment"
            quote={note}
            testId="social-quote-composer"
          />
          <div className="max-h-48 overflow-y-auto px-4 pb-4 pt-2 text-sm">
            <PostContent embed={false} text={note.content} />
          </div>
        </>
      ) : null}
    </dialog>
  );
}
