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
 * the first button, or the dialog itself when it should be read from its
 * title); otherwise the first focusable element is.
 *
 * `returnFocus` is where focus goes on close when whatever opened the dialog is
 * gone by then (an item in a menu that closed behind it).
 */
export function useFocusTrap<
  T extends HTMLElement,
  I extends HTMLElement = HTMLElement,
>(
  containerRef: RefObject<T | null>,
  {
    initialFocus,
    returnFocus,
  }: {
    initialFocus?: RefObject<I | null>;
    returnFocus?: RefObject<HTMLElement | null>;
  } = {},
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
      // The dialog itself (focused on open) comes before its first control: Shift+Tab from it wraps too.
      const atStart =
        active === first || active === container || !container.contains(active);
      if (event.shiftKey && atStart) {
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
      const back = previous?.isConnected ? previous : returnFocus?.current;
      back?.focus?.();
    };
  }, [containerRef, initialFocus, returnFocus]);
}
