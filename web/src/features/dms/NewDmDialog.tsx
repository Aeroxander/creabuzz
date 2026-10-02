import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { nip19 } from "nostr-tools";

/**
 * Start a conversation with one person, by public key (hex) or npub.
 *
 * The dialog owns its own submit path: it validates the recipient up front,
 * hands the pubkey to `onStart`, and reports failure inline with the form
 * still filled in so the reader can fix or retry.
 */
export function NewDmDialog({
  pending,
  error,
  onStart,
  onClose,
}: {
  pending: boolean;
  error: string | null;
  onStart: (pubkey: string) => void;
  onClose: () => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus lands in the field on open (programmatically — no autoFocus), and
  // Escape closes: keyboard parity with the pointer affordances (cancel
  // button, backdrop) that already close the dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog mounts fresh on every open, so this runs once per open
  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const raw = recipient.trim();
    if (!raw || pending) return;
    let pubkey: string;
    try {
      pubkey = raw.toLowerCase().startsWith("npub1")
        ? String(nip19.decode(raw).data)
        : raw.toLowerCase();
    } catch {
      setLocalError(
        "That doesn't look like an npub — check the address and try again.",
      );
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      setLocalError(
        "That doesn't look like a public key — paste a 64-character key or an npub.",
      );
      return;
    }
    setLocalError(null);
    onStart(pubkey);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <button
        type="button"
        aria-label="Close new message dialog"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-dm-title"
        className="relative w-full max-w-md rounded-2xl border border-black/10 bg-white p-4 shadow-xl dark:border-white/10"
        data-testid="new-dm-dialog"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2
            id="new-dm-title"
            className="text-sm font-semibold text-black dark:text-white"
          >
            New message
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
        <form onSubmit={submit}>
          <label
            htmlFor="new-dm-recipient"
            className="mb-1 block text-xs text-black/60 dark:text-white/60"
          >
            Who do you want to message?
          </label>
          <input
            id="new-dm-recipient"
            ref={inputRef}
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value);
              setLocalError(null);
            }}
            placeholder="Public key or npub"
            className="w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm text-black outline-none placeholder:text-black/40 focus:border-black/30 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/30"
            data-testid="new-dm-recipient"
          />
          {(localError ?? error) != null && (
            <p
              role="alert"
              className="mt-2 text-xs text-red-700 dark:text-red-300"
              data-testid="new-dm-error"
            >
              {localError ?? error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || recipient.trim().length === 0}
              className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              data-testid="new-dm-start"
            >
              {pending ? "Starting…" : "Start conversation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
