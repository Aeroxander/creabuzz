/**
 * A Start pressed by someone who has no account yet: the press waits in session storage while they sign up, and the Start
 * page they return to sends the project they typed (its draft is kept there too), so one press is enough. It is used up once
 * and goes stale after ten minutes, like a Back made before signing up (`../pot/back-after-sign-up.ts`).
 */
type SignUpStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const KEY = "creaton.start.after-sign-up";
/** How long a press made while signed out stays good. */
const GOOD_MS = 10 * 60_000;

/** Remember that Start was pressed with no account. */
export function markStartAfterSignUp(
  store: SignUpStore | null | undefined,
  now: number = Date.now(),
): void {
  try {
    store?.setItem(KEY, String(now));
  } catch {
    // Storage refused: the person presses Start again once signed up.
  }
}

/** Whether a press is waiting and still good. It is forgotten either way, so it sends at most once. */
export function takeStartAfterSignUp(
  store: SignUpStore | null | undefined,
  now: number = Date.now(),
): boolean {
  try {
    const raw = store?.getItem(KEY);
    store?.removeItem(KEY);
    const at = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(at) && now - at >= 0 && now - at <= GOOD_MS;
  } catch {
    // Storage refused or unreadable: nothing was kept.
    return false;
  }
}
