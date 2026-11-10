import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { PersonSearch } from "@/features/social/ui/PersonSearch";
import type { FailureWords } from "@/shared/lib/readable-error";
import { FailureNote } from "@/shared/ui/failure-note";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { MODAL_CONTENT_MOTION_CLASS } from "@/shared/ui/modalMotion";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";

/**
 * Start a conversation in this community with one person, found by name (or by a pasted public key) with the same
 * person search Messages on Home uses.
 *
 * Picking a person hands their key to `onStart`; while that is pending nothing else can be picked, and a failure is
 * reported inline with the search still there so the reader can retry or pick someone else.
 */
export function NewDmDialog({
  me,
  pending,
  error,
  onStart,
  onClose,
}: {
  me: string;
  pending: boolean;
  error: FailureWords | null;
  onStart: (pubkey: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus starts in the search and stays in the dialog; it goes back to the + button on close.
  useFocusTrap(panelRef, { initialFocus: inputRef });

  // Escape closes: keyboard parity with the pointer affordances (Cancel, the backdrop) that already close the dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog mounts fresh on every open, so this runs once per open
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close new chat dialog"
        className={`absolute inset-0 cursor-default bg-black/40 ${MODAL_BACKDROP_BLUR_CLASS}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-dm-title"
        className={`relative w-full max-w-md rounded-2xl border border-black/10 bg-background p-4 text-foreground shadow-xl dark:border-white/10 ${MODAL_CONTENT_MOTION_CLASS}`}
        data-testid="new-dm-dialog"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2
            id="new-dm-title"
            className="text-sm font-semibold text-black dark:text-white"
          >
            New chat in this community
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1.5 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <PersonSearch
          disabled={pending}
          inputId="new-dm-recipient"
          inputRef={inputRef}
          inputTestId="new-dm-recipient"
          label="Who do you want to message?"
          me={me}
          onPick={(pubkey) => {
            if (!pending) onStart(pubkey);
          }}
        />
        {pending ? (
          <p
            className="mt-2 text-xs text-black/60 dark:text-white/60"
            data-testid="new-dm-pending"
            role="status"
          >
            Starting the chat…
          </p>
        ) : error != null ? (
          <FailureNote
            className="mt-2 text-xs"
            failure={error}
            testId="new-dm-error"
          />
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
