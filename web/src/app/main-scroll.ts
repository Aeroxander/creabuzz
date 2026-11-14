/**
 * The root layout's `<main>` is the page's scroll container, so the router's window scroll restoration never sees
 * it. A new page starts at the top (`scrollToTopSelectors` in `router.tsx`); Back and Forward return to where the
 * person was on that page, which is what this module adds on top.
 */

import type { AnyRouter } from "@tanstack/react-router";

/** The root layout's `<main>`: the scroll container a new page starts at the top of (`router.tsx`). */
export const MAIN_ID = "app-main";

/** Frames to wait for a page's content to grow tall enough to reach its saved position (about half a second). */
const MAX_RESTORE_FRAMES = 30;

/** History actions that move through entries already visited (the browser's Back and Forward, `history.go`). */
export function isTraversal(type: string): boolean {
  return type === "BACK" || type === "FORWARD" || type === "GO";
}

/**
 * Where `<main>` should be after a new page renders: the position saved for that page when the person went back or
 * forward to it, else the top.
 */
export function mainScrollTarget(
  traversal: boolean,
  saved: number | undefined,
): number {
  return traversal && saved !== undefined ? saved : 0;
}

/** Restore `<main>`'s position on Back and Forward, keyed by pathname as the router's own restoration is. */
export function installMainScrollRestoration(router: AnyRouter): void {
  if (typeof document === "undefined") return;
  const saved = new Map<string, number>();
  let traversal = false;
  // Fences a restore still waiting for content when the person has already moved on.
  let generation = 0;
  const main = () => document.getElementById(MAIN_ID);

  router.history.subscribe(({ action }: { action: { type: string } }) => {
    traversal = isTraversal(action.type);
  });
  router.subscribe("onBeforeLoad", (event) => {
    // The page being left is still on screen here.
    const element = main();
    if (event.fromLocation && element) {
      saved.set(event.fromLocation.pathname, element.scrollTop);
    }
  });
  router.subscribe("onRendered", (event) => {
    const wasTraversal = traversal;
    traversal = false;
    const current = ++generation;
    if (!event.pathChanged || event.toLocation.hash) return;
    const target = mainScrollTarget(
      wasTraversal,
      saved.get(event.toLocation.pathname),
    );
    if (target === 0) return; // the router has already put a new page at the top
    // After the router's own handler, which resets <main> to the top first.
    queueMicrotask(() => {
      let frames = 0;
      let placed: number | null = null;
      const restore = () => {
        const element = main();
        if (!element || current !== generation) return;
        // The person scrolled while the page was still filling in: leave them where they are.
        if (placed !== null && Math.abs(element.scrollTop - placed) > 1) return;
        element.scrollTop = target;
        placed = element.scrollTop;
        // Short of it only because the page has not grown tall enough yet: try again, a bounded number of times.
        if (placed < target - 1 && ++frames < MAX_RESTORE_FRAMES) {
          requestAnimationFrame(restore);
        }
      };
      restore();
    });
  });
}
