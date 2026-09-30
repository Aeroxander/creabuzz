/**
 * Version history panel: a page's revision list and restore.
 *
 * Restoring publishes an old revision's content as a NEW revision
 * (`lib/wiki-history.ts`) — history grows, it is never rewritten — so the
 * confirm here is a plain dialog, not a destructive one: nothing is lost, a new
 * version is simply added on top. Keyboard and pointer both reach every
 * action; each action has exactly one accessible label owner.
 */

import { useEffect, useId, useRef, useState } from "react";
import { History, RotateCcw } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { relativeTime } from "@/shared/lib/relative-time";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { MODAL_CONTENT_MOTION_CLASS } from "@/shared/ui/modalMotion";

import type { Revision } from "../lib/wiki-history";
import { truncatePubkey } from "@/shared/lib/pubkey";

function RestoreConfirm({
  revision,
  onCancel,
  onConfirm,
}: {
  revision: Revision;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const containerRef = useRef<HTMLFormElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  useFocusTrap(containerRef, { initialFocus: confirmRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      <button
        aria-label="Close"
        className={`absolute inset-0 cursor-default bg-black/40 ${MODAL_BACKDROP_BLUR_CLASS}`}
        onClick={onCancel}
        type="button"
      />
      <form
        aria-labelledby={titleId}
        className={`relative w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl ${MODAL_CONTENT_MOTION_CLASS}`}
        ref={containerRef}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
        role="dialog"
        aria-modal="true"
        data-testid="restore-confirm"
      >
        <h2
          className="text-lg font-semibold text-black dark:text-white"
          id={titleId}
        >
          Restore this version?
        </h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This publishes the version from {relativeTime(revision.createdAt)} as
          the page&apos;s newest version. Nothing is deleted — the current
          version stays in the history.
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            data-testid="restore-confirm-accept"
            ref={confirmRef}
            type="submit"
          >
            Restore this version
          </Button>
        </div>
      </form>
    </div>
  );
}

export function VersionHistory({
  revisions,
  restoring,
  onRestore,
}: {
  revisions: Revision[];
  restoring: boolean;
  onRestore: (revision: Revision) => void;
}) {
  const [pending, setPending] = useState<Revision | null>(null);

  if (revisions.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-6 text-sm text-black/60 dark:text-white/60"
        data-testid="version-history-empty"
      >
        No earlier versions yet.
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
      data-testid="version-history"
    >
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-black/70 dark:text-white/70">
        <History className="h-3.5 w-3.5" aria-hidden="true" /> Version history
      </p>
      <ul className="space-y-1.5">
        {revisions.map((revision, index) => (
          <li
            key={revision.id}
            className="rounded-md border border-black/10 p-2 dark:border-white/10"
            data-testid={`version-row-${index}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-black/80 dark:text-white/80">
                {relativeTime(revision.createdAt)}
              </span>
              <span
                className="shrink-0 text-2xs text-black/50 dark:text-white/50"
                title={revision.authorPubkey}
              >
                {truncatePubkey(revision.authorPubkey)}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-2xs text-black/60 dark:text-white/60">
              {revision.excerpt || "(empty)"}
            </p>
            <button
              type="button"
              onClick={() => setPending(revision)}
              disabled={restoring}
              className="mt-1.5 inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 text-xs text-black/70 hover:bg-black/5 disabled:opacity-40 dark:border-white/15 dark:text-white/70 dark:hover:bg-white/10"
              data-testid={`restore-${index}`}
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" /> Restore this
              version
            </button>
          </li>
        ))}
      </ul>

      {pending ? (
        <RestoreConfirm
          revision={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const revision = pending;
            setPending(null);
            if (revision) onRestore(revision);
          }}
        />
      ) : null}
    </div>
  );
}
