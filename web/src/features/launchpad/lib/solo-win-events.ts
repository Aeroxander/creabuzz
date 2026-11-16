/**
 * Asking the page to open the "What did you get done?" box from somewhere else, in the style of `SIGN_UP_EVENT`: a
 * promise line, an empty record, the first-week card. The box listens once and opens itself; nothing is sent here.
 *
 * Alias-free: `solo-win.test.mjs` drives it under `node --test`.
 */

/** The window event that asks the project page to open the solo box. */
const SOLO_WIN_EVENT = "creaton:solo-win";

/** What the box opens with: some words already typed, or an existing task to finish. */
export interface SoloWinOpen {
  /** The line the person did, filled in for them to confirm or change. */
  text?: string;
  /** A task the founder already has: the box then hands in and checks it, instead of making a new one. */
  taskId?: string;
}

/** Ask the project page to open the solo box. */
export function openSoloWin(
  open: SoloWinOpen = {},
  target: Pick<EventTarget, "dispatchEvent"> = window,
): void {
  target.dispatchEvent(
    new CustomEvent<SoloWinOpen>(SOLO_WIN_EVENT, { detail: open }),
  );
}

/**
 * Listen for `openSoloWin`. Returns the function that stops listening. `target` is the window unless a test names
 * another.
 */
export function onOpenSoloWin(
  handler: (open: SoloWinOpen) => void,
  target: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  > = window,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<SoloWinOpen | undefined>).detail;
    handler({
      ...(typeof detail?.text === "string" ? { text: detail.text } : {}),
      ...(typeof detail?.taskId === "string" ? { taskId: detail.taskId } : {}),
    });
  };
  target.addEventListener(SOLO_WIN_EVENT, listener);
  return () => target.removeEventListener(SOLO_WIN_EVENT, listener);
}
