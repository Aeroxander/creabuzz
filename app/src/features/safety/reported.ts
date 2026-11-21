/**
 * The posts this person reported, kept on this phone so they stop showing for them at once. A report goes to the people who
 * run the server and is not shown back to anyone, so there is no list to read it from again: this is the only record, and it
 * is said so where it is used ("hidden for you on this phone"). Kept per account in this browser's storage, every access
 * inside `try` (with no storage the post simply shows again), newest last, and never more than {@link MAX_REPORTED}.
 */
import { useSyncExternalStore } from "react";
import { useAccount } from "../../lib/account";

const PREFIX = "creaton.reported.";
/** The most reported posts kept per account; the oldest make way. */
export const MAX_REPORTED = 500;

const HEX64 = /^[0-9a-f]{64}$/;
const NOBODY: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();
const cache = new Map<string, ReadonlySet<string>>();

function load(me: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(PREFIX + me) ?? "[]",
    );
    if (!Array.isArray(parsed)) return NOBODY;
    return new Set(
      parsed.filter(
        (id): id is string => typeof id === "string" && HEX64.test(id),
      ),
    );
  } catch {
    return NOBODY;
  }
}

/** The ids of the posts `me` reported. */
export function reportedBy(me: string | null): ReadonlySet<string> {
  if (!me) return NOBODY;
  let set = cache.get(me);
  if (!set) {
    set = load(me);
    cache.set(me, set);
  }
  return set;
}

function store(me: string, ids: readonly string[]) {
  const kept = ids.slice(-MAX_REPORTED);
  cache.set(me, new Set(kept));
  try {
    localStorage.setItem(PREFIX + me, JSON.stringify(kept));
  } catch {
    // Not kept past this tab; it still counts until the page is closed.
  }
  for (const listener of listeners) listener();
}

/** Remember that `me` reported the post `id`. */
export function rememberReported(me: string, id: string): void {
  const have = [...reportedBy(me)].filter((x) => x !== id);
  store(me, [...have, id]);
}

/** Show a reported post again for `me`. */
export function forgetReportedPost(me: string, id: string): void {
  store(
    me,
    [...reportedBy(me)].filter((x) => x !== id),
  );
}

/** Drops what this browser kept, so the next person to sign in on it never inherits it. Called when signing out. */
export function forgetAllReported(): void {
  cache.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // No storage: nothing was kept.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The posts the signed-in person reported, and the two ways to change it. */
export function useReported() {
  const { pubkey } = useAccount();
  const reported = useSyncExternalStore(
    subscribe,
    () => reportedBy(pubkey),
    () => NOBODY,
  );
  return {
    reported,
    add: (id: string) => {
      if (pubkey) rememberReported(pubkey, id);
    },
    undo: (id: string) => {
      if (pubkey) forgetReportedPost(pubkey, id);
    },
  };
}
