import { useEffect, useRef, type ReactNode } from "react";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { Portal } from "@/shared/ui/portal";
import { useFocusTrap } from "@/shared/ui/use-focus-trap";

/**
 * Minimal modal shell: fixed overlay + card. Backdrop click or Escape closes.
 *
 * Portalled to the document root so it covers the whole window: rendered in place, an ancestor with a filter or
 * transform (the page column) boxed the overlay into that column and left the header and side rails bright and
 * clickable. The card never grows past the window; a long form scrolls inside it, and a footer marked
 * `modal-footer` (see {@link MODAL_FOOTER_CLASS}) stays in view while it does.
 */
export function Modal({
  label,
  onClose,
  children,
  wide = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Forms with side-by-side fields; the default suits short confirmations. */
  wide?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Tab stays inside the card; focus returns to the opener on close.
  useFocusTrap(containerRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Backdrop dismiss is mouse-only by design; keyboard users get Escape
  // (effect above) plus the dialog's own tab order.
  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dismiss layer only */}
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 dark:bg-black/50 ${MODAL_BACKDROP_BLUR_CLASS}`}
        data-testid="modal-backdrop"
        onClick={onClose}
        role="presentation"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation */}
        <div
          aria-label={label}
          className={`max-h-[calc(100dvh-2rem)] w-full min-w-0 overflow-y-auto overscroll-contain glass-dialog rounded-2xl border p-5 shadow-2xl ${wide ? "max-w-2xl" : "max-w-lg"}`}
          onClick={(e) => e.stopPropagation()}
          ref={containerRef}
          role="dialog"
          aria-modal="true"
        >
          {children}
        </div>
      </div>
    </Portal>
  );
}

/**
 * For a dialog's row of buttons: stays at the bottom of the card while a long form scrolls, so Cancel and the main
 * action are always on screen. Bleeds to the card's sides (its p-5) and paints the card's own background (white in light
 * mode, as `.glass-dialog` does). No negative bottom margin: pulling it into the card's padding made every dialog
 * overflow a little, so the footer sat over the last field's border and focus ring even with nothing to scroll.
 */
export const MODAL_FOOTER_CLASS =
  "sticky bottom-0 -mx-5 mt-1 bg-white px-5 py-3 dark:bg-card";
