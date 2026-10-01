import { useEffect, useRef } from "react";

import type { Post, Profile } from "../feed-model";
import { Composer } from "./Composer";

/** Native `<dialog>` hosting the quote-post composer. */
export function QuoteDialog({
  open,
  onClose,
  post,
  viewer,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  post: Post;
  viewer: string | null;
  profile?: Profile;
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
      ref={ref}
      onClose={onClose}
      aria-label="Quote post"
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl border bg-background p-0 text-foreground backdrop:bg-black/50"
    >
      {open && (
        <Composer
          viewer={viewer}
          profile={profile}
          quote={{ id: post.event.id, author: post.event.pubkey }}
          placeholder="Add a comment"
          autoFocus
          onSent={onClose}
        />
      )}
    </dialog>
  );
}
