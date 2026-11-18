import { useEffect, useId, useRef, useState } from "react";

import { normalizeSlug } from "../lib/slug";

import { useFocusTrap } from "@/shared/ui/use-focus-trap";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { MODAL_CONTENT_MOTION_CLASS } from "@/shared/ui/modalMotion";

/** Turn free text into a page slug: lowercase, hyphen-separated, url-safe. */

/**
 * Ask for a wiki page name.
 *
 * Replaces `window.prompt`, which blocks the page on mobile browsers and cannot
 * be styled, labelled, or validated.
 */
export function PageDialog({
  title,
  description,
  initialValue = "",
  confirmLabel,
  takenSlugs,
  onCancel,
  onSubmit,
}: {
  title: string;
  description?: string;
  initialValue?: string;
  confirmLabel: string;
  /** Slugs already in use; a clash is refused before publishing. */
  takenSlugs?: string[];
  onCancel: () => void;
  onSubmit: (slug: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLFormElement | null>(null);

  // Focus starts in the name field and Tab stays inside the dialog.
  useFocusTrap(containerRef, { initialFocus: inputRef });

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const slug = normalizeSlug(value);
  const taken = slug.length > 0 && (takenSlugs ?? []).includes(slug);
  const invalid = slug.length === 0 || taken;
  const message = taken
    ? `"${slug}" is already a page.`
    : slug.length === 0
      ? "Use at least one letter or number."
      : `Saved as ${slug}`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      {/* Real control rather than a click handler on a static element; Escape
            (effect above) and Cancel both close it. */}
      <button
        aria-label="Close"
        className={`absolute inset-0 cursor-default bg-black/40 ${MODAL_BACKDROP_BLUR_CLASS}`}
        onClick={onCancel}
        type="button"
      />
      <form
        aria-label={title}
        className={`relative w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl ${MODAL_CONTENT_MOTION_CLASS}`}
        ref={containerRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid) return;
          onSubmit(slug);
        }}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-semibold text-black dark:text-white">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            {description}
          </p>
        ) : null}
        <label
          className="mt-4 block text-sm font-medium text-black/70 dark:text-white/70"
          htmlFor={inputId}
        >
          Page name
        </label>
        <Input
          className="mt-1"
          id={inputId}
          onChange={(e) => setValue(e.target.value)}
          placeholder="release-notes"
          ref={inputRef}
          value={value}
          data-testid="page-name-input"
        />
        <p
          className={`mt-1.5 text-xs ${invalid ? "text-amber-700 dark:text-amber-400" : "text-black/60 dark:text-white/60"}`}
          data-testid="page-name-hint"
        >
          {message}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={invalid}
            data-testid="page-name-confirm"
            type="submit"
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
