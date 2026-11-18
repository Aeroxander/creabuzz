/**
 * Keeps the cursor on the page when a one-shot button goes away.
 *
 * Collect, Settle, Take back, Open the round, Check older rounds, Show older rounds and Try again each vanish once their step has landed and the card
 * has refreshed. A removed control that held the cursor drops it on the page body, so a keyboard or screen-reader user
 * starts again from the top. A control opts in with `rescueFocus(...)`; when one that held the cursor leaves the page,
 * the cursor goes to a stable, readable line that reports the result (marked with `homeFocus(...)`, `tabIndex={-1}`).
 *
 * It only moves the cursor when it was on that control and now is on nothing. Anyone who has tabbed or clicked on to
 * something else (or pressed the mouse anywhere) is left where they are.
 */

import { type RefObject, useEffect } from "react";

const RESCUE = "data-focus-rescue";
const HOME = "data-focus-home";

/**
 * Where the cursor lands: a line about one round's orders, the older-rounds note, the earlier-rounds list's heading, or
 * (last) the card's own heading.
 */
type FocusHome = "round" | "older" | "history" | "card";

/** Spread onto a one-shot button: if it leaves the page holding the cursor, the cursor goes to `home`. */
export function rescueFocus(home: FocusHome): Record<string, string> {
  return { [RESCUE]: home };
}

/** Spread onto a line that can take the cursor (it also needs `tabIndex={-1}`). */
export function homeFocus(home: FocusHome): Record<string, string> {
  return { [HOME]: home };
}

/** Watch `card` for an opted-in control that held the cursor and left the page. */
export function useFocusRescue(card: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = card.current;
    if (root === null) return;
    let held: { element: Element; home: string } | null = null;
    // The newest focus wins: a marked control inside the card holds the cursor, anything else releases it.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      held =
        target instanceof Element &&
        root.contains(target) &&
        target.hasAttribute(RESCUE)
          ? { element: target, home: target.getAttribute(RESCUE) ?? "card" }
          : null;
    };
    // A press anywhere is the person moving on; a focus that follows it (a click on a button) is read again above.
    const onPointerDown = () => {
      held = null;
    };
    const observer = new MutationObserver(() => {
      if (held === null || held.element.isConnected) return;
      const { home } = held;
      held = null;
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const target = [home, "round", "card"]
        .map((name) => root.querySelector<HTMLElement>(`[${HOME}="${name}"]`))
        .find((element) => element !== null);
      target?.focus();
    });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
      observer.disconnect();
    };
  }, [card]);
}
