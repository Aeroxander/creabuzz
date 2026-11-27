/**
 * A Back typed by someone who has no account yet: the amount waits in session storage while they sign up, and the Back box of
 * that same project opens the sheet with it when they return, so they do not type it twice. It names the project, it is used
 * up once, and it goes stale after ten minutes (like Ask to join, `@creaton/core/project/join.ts`).
 */
type SignUpStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const KEY = "creaton.back.after-sign-up";
/** How long an amount typed while signed out stays good: after that the person types it again. */
const GOOD_MS = 10 * 60_000;

/** Keep `text` (the dollars as typed) for the project `projectKey`. */
export function markBackAfterSignUp(
  store: SignUpStore | null | undefined,
  projectKey: string,
  text: string,
  now: number = Date.now(),
): void {
  try {
    store?.setItem(KEY, JSON.stringify({ at: now, projectKey, text }));
  } catch {
    // Storage refused: the person types the amount again once signed up.
  }
}

/** The amount kept for this project, once: it is forgotten whether or not it was for this project and still good. */
export function takeBackAfterSignUp(
  store: SignUpStore | null | undefined,
  projectKey: string,
  now: number = Date.now(),
): string | null {
  try {
    const raw = store?.getItem(KEY);
    store?.removeItem(KEY);
    const kept = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (
      kept &&
      kept.projectKey === projectKey &&
      typeof kept.text === "string" &&
      typeof kept.at === "number" &&
      now - kept.at >= 0 &&
      now - kept.at <= GOOD_MS
    )
      return kept.text;
  } catch {
    // Storage refused or unreadable: nothing was kept.
  }
  return null;
}
