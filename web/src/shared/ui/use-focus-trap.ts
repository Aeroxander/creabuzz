import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep keyboard focus inside a dialog, and give it back when the dialog closes.
 *
 * The Radix alert dialog traps focus for us; the hand-rolled dialogs (wiki page
 * naming, launchpad modal) did not, so Tab walked into the page behind the
 * overlay and the user lost their place.
 *
 * `initialFocus` is focused on open when given (a text input should win over
 * the first button); otherwise the first focusable element is.
 */
export function useFocusTrap<
  T extends HTMLElement,
  I extends HTMLElement = HTMLElement,
>(
  containerRef: RefObject<T | null>,
  { initialFocus }: { initialFocus?: RefObject<I | null> } = {},
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusables = () =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) =>
          element.offsetParent !== null || element === document.activeElement,
      );

    const target = initialFocus?.current ?? focusables()[0] ?? container;
    target.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Returning focus to whatever opened the dialog keeps the keyboard flow.
      previous?.focus?.();
    };
  }, [containerRef, initialFocus]);
}
