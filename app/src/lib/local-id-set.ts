/**
 * A short list of ids a person keeps on this phone for themselves (the posts they reported, the pictures they hid), per
 * account, in this browser's storage. Every access is inside `try` (with no storage the list lasts until the page is
 * closed), newest last, never more than `max`, and dropped as a whole on sign-out so the next person on a shared phone never
 * inherits it.
 */
import { useSyncExternalStore } from "react";
import { useAccount } from "./account";

const NOBODY: ReadonlySet<string> = new Set();

export function createLocalIdSet({
  prefix,
  max,
  valid,
}: {
  /** The storage key's start; the account follows. */
  prefix: string;
  /** The most ids kept per account; the oldest make way. */
  max: number;
  /** Which ids are kept (anything else in storage is ignored). */
  valid: (id: string) => boolean;
}) {
  const listeners = new Set<() => void>();
  const cache = new Map<string, ReadonlySet<string>>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  function load(me: string): ReadonlySet<string> {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(prefix + me) ?? "[]",
      );
      if (!Array.isArray(parsed)) return NOBODY;
      return new Set(
        parsed.filter(
          (id): id is string => typeof id === "string" && valid(id),
        ),
      );
    } catch {
      return NOBODY;
    }
  }

  function of(me: string | null): ReadonlySet<string> {
    if (!me) return NOBODY;
    let set = cache.get(me);
    if (!set) {
      set = load(me);
      cache.set(me, set);
    }
    return set;
  }

  function store(me: string, ids: readonly string[]) {
    const kept = ids.slice(-max);
    cache.set(me, new Set(kept));
    try {
      localStorage.setItem(prefix + me, JSON.stringify(kept));
    } catch {
      // Not kept past this tab; it still counts until the page is closed.
    }
    notify();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  const api = {
    of,
    subscribe,
    add(me: string, id: string) {
      store(me, [...[...of(me)].filter((x) => x !== id), id]);
    },
    remove(me: string, id: string) {
      store(
        me,
        [...of(me)].filter((x) => x !== id),
      );
    },
    /** Drops everything this browser kept, for every account. */
    clearAll() {
      cache.clear();
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key?.startsWith(prefix)) localStorage.removeItem(key);
        }
      } catch {
        // No storage: nothing was kept.
      }
      notify();
    },
  };
  return api;
}

/** The signed-in person's list in `set`, and the two ways to change it. */
export function useLocalIdSet(set: ReturnType<typeof createLocalIdSet>) {
  const { pubkey } = useAccount();
  const ids = useSyncExternalStore(
    set.subscribe,
    () => set.of(pubkey),
    () => NOBODY,
  );
  return {
    ids,
    add: (id: string) => {
      if (pubkey) set.add(pubkey, id);
    },
    remove: (id: string) => {
      if (pubkey) set.remove(pubkey, id);
    },
  };
}
