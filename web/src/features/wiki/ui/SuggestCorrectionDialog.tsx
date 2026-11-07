/**
 * "Suggest a correction" dialog for a read-only agent page.
 *
 * Agent pages are maintained by a distillation loop, so a reader who spots an
 * error cannot edit the page directly. Instead they file a correction: a
 * durable proposal recorded alongside the page (`lib/knowledge.ts`). The
 * suggestion is adopted by a later agent run — the consumption hook is a
 * documented TODO, not something this dialog pretends to do.
 */

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { MODAL_CONTENT_MOTION_CLASS } from "@/shared/ui/modalMotion";

export function SuggestCorrectionDialog({
  slug,
  submitting,
  onCancel,
  onSubmit,
}: {
  slug: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const textareaId = useId();
  const containerRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useFocusTrap(containerRef, { initialFocus: textareaRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const invalid = note.trim().length === 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      <button
        aria-label="Close"
        className={`absolute inset-0 cursor-default bg-black/40 ${MODAL_BACKDROP_BLUR_CLASS}`}
        onClick={onCancel}
        type="button"
      />
      <form
        aria-label={`Suggest a correction to ${slug}`}
        className={`relative w-full max-w-md rounded-3xl bg-background p-6 shadow-2xl ${MODAL_CONTENT_MOTION_CLASS}`}
        ref={containerRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid) return;
          onSubmit(note.trim());
        }}
        role="dialog"
        aria-modal="true"
        data-testid="suggest-correction-dialog"
      >
        <h2 className="text-lg font-semibold text-black dark:text-white">
          Suggest a correction
        </h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This page is kept up to date by an agent, so it can&apos;t be edited
          here. Describe the correction and it&apos;ll be reviewed and folded
          into a later update.
        </p>
        <label
          className="mt-4 block text-sm font-medium text-black/70 dark:text-white/70"
          htmlFor={textareaId}
        >
          Your correction
        </label>
        <textarea
          className="mt-1 h-32 w-full resize-none rounded-md border border-black/10 bg-white p-2 text-sm text-black outline-none focus:ring-1 focus:ring-black dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:ring-white"
          id={textareaId}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What should change, and why?"
          ref={textareaRef}
          value={note}
          data-testid="suggest-correction-note"
        />
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={invalid || submitting}
            data-testid="suggest-correction-submit"
            type="submit"
          >
            {submitting ? "Sending…" : "Suggest a correction"}
          </Button>
        </div>
      </form>
    </div>
  );
}
