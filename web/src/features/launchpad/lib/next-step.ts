/**
 * Putting Home's next-step line away for a day.
 *
 * Kept in the browser, for one person on one server: a note of when it was put away. It comes back a day later, or at
 * once for someone else signing in. A refused or unreadable note only means the line shows.
 *
 * Pure and alias-free: `next-step.test.mjs` drives it under `node --test`.
 */

/** How long a put-away line stays away. */
export const NEXT_STEP_QUIET_SECONDS = 86_400;
const KEY = "creaton.next-step.dismissed";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether `scope` (the server and the person) put the line away less than a day ago. */
export function nextStepDismissed(
  store: Store | null | undefined,
  scope: string,
  now: number,
): boolean {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return false;
    const { scope: kept, at } = value as Record<string, unknown>;
    return (
      kept === scope &&
      typeof at === "number" &&
      // A note dated ahead of now (a changed clock) hides nothing.
      at <= now &&
      now - at < NEXT_STEP_QUIET_SECONDS
    );
  } catch {
    return false;
  }
}

/** Put the line away now. False when the browser would not keep the note (the line then only hides for this visit). */
export function dismissNextStep(
  store: Store | null | undefined,
  scope: string,
  now: number,
): boolean {
  try {
    if (!store) return false;
    store.setItem(KEY, JSON.stringify({ scope, at: now }));
    return true;
  } catch {
    return false;
  }
}
