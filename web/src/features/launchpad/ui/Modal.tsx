import {
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
  role = "dialog",
  labelledBy,
  describedBy,
  initialFocus,
  className,
}: {
  /** The dialog's accessible name, unless `labelledBy` points at its visible title. */
  label: string;
  /** Escape and a click on the backdrop call this; a dialog busy with work it must not abandon ignores it there. */
  onClose: () => void;
  children: ReactNode;
  /** Forms with side-by-side fields; the default suits short confirmations. */
  wide?: boolean;
  /** `alertdialog` for a destructive confirm that interrupts the person. */
  role?: "dialog" | "alertdialog";
  /** Id of the visible title; it names the dialog in place of `label`. */
  labelledBy?: string;
  /** Id of the text that says what the dialog does. */
  describedBy?: string;
  /** What gets focus on open (Cancel for a destructive confirm); the first control otherwise. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Replaces the card's width (e.g. `max-w-sm`). */
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Tab stays inside the card; focus returns to the opener on close.
  useFocusTrap(containerRef, { initialFocus });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The card is the same for both roles; each role is written out where it is used.
  const card = {
    "aria-describedby": describedBy,
    "aria-label": labelledBy ? undefined : label,
    "aria-labelledby": labelledBy,
    "aria-modal": true,
    className: `max-h-[calc(100dvh-2rem)] w-full min-w-0 overflow-y-auto overscroll-contain glass-dialog rounded-2xl border p-5 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring ${className ?? (wide ? "max-w-2xl" : "max-w-lg")}`,
    // Only stops the backdrop's click from closing the card; nothing to do from the keyboard.
    onClick: (e: MouseEvent) => e.stopPropagation(),
    ref: containerRef,
    // Focusable itself, so focus has somewhere to stay inside the card when every control is busy or gone.
    tabIndex: -1,
  };

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
        {role === "alertdialog" ? (
          <div role="alertdialog" {...card}>
            {children}
          </div>
        ) : (
          <div role="dialog" {...card}>
            {children}
          </div>
        )}
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
