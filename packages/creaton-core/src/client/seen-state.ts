/**
 * When a person last looked at their notifications: one time, kept in the browser for one account on one server.
 *
 * There used to be two notes of it under two keys (one for the rooms' bell, kept for the whole browser whoever was
 * signed in; one for the timeline's bell, kept per account but not per server). Someone signing in after another
 * person inherited that person's "read up to", and looking at one bell left the other counting. Now both bells read
 * and write this one time, in seconds, under a key that names the server and the account.
 *
 * The older per-account note is read once as a starting point (it was this account's own); the older browser-wide
 * note is not, since it may be someone else's.
 *
 * Pure and alias-free: `seen-state.test.mjs` drives it under `node --test`.
 */

/** Said on the page when the time changes, so every count of new notifications follows at once. */
export const SEEN_EVENT = "creaton:notifications-seen";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The key the time is kept under for `account` on `server`. */
export function seenKey(server: string, account: string): string {
  return `creaton.notifications.seen.${server}|${account.toLowerCase()}`;
}

const legacyKey = (account: string) =>
  `buzz.social.notifications.seen.${account}`;

/** When `account` last looked, in seconds; 0 when never (or when the browser will not say). */
export function readSeen(
  store: Store | null | undefined,
  server: string,
  account: string,
): number {
  try {
    const own = Number(store?.getItem(seenKey(server, account)));
    if (Number.isFinite(own) && own > 0) return own;
    const before = Number(store?.getItem(legacyKey(account)));
    return Number.isFinite(before) && before > 0 ? before : 0;
  } catch {
    return 0;
  }
}

/**
 * Note that `account` has looked up to `at` (seconds). Never moves backwards. False when the browser would not keep
 * it: the counts then only drop for this visit.
 */
export function writeSeen(
  store: Store | null | undefined,
  server: string,
  account: string,
  at: number,
): boolean {
  try {
    if (!store) return false;
    const next = Math.max(readSeen(store, server, account), Math.floor(at));
    store.setItem(seenKey(server, account), String(next));
    return true;
  } catch {
    return false;
  }
}
