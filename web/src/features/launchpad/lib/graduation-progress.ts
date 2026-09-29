/**
 * Durable record of the confirmed `executeGraduation` transaction hash.
 *
 * The flow's in-memory resume set does not survive a page reload: if the money
 * call lands and the page reloads before the 47005 receipts publish, the
 * receipts must still be bound to that hash (the relay requires exactly one
 * `tx` tag, ingest.rs:2111-2114). The hash is persisted the moment `send`
 * returns, and read back to resume after a reload. It is also the manual
 * recovery affordance: when no hash exists anywhere, the UI lets the founder
 * supply it and it lands in the same place.
 *
 * One launch = one key = one atomic write (Review-Proven Rule 5). `launchKey`
 * is the launch's auction address — the launch id both the flow
 * (`GraduationExecution.auction`) and the panel (`record.auction`) see.
 */

/** 0x + 64 hex — also the relay's `tx` tag contract (ingest.rs:2093-2100). */
export const GRADUATION_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** The one-key store for one launch's graduation tx hash. */
export interface GraduationTxStore {
  /** The persisted hash, or null when none is stored (or it is corrupt). */
  load(): string | null;
  /** Persist a confirmed hash. Throws on a malformed one — never store garbage. */
  save(txHash: string): void;
  /** Drop the persisted hash. */
  clear(): void;
}

/** The slice of Web Storage this module needs (tests inject a fake). */
export type GraduationTxStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const PREFIX = "buzz:launchpad:graduation-tx:";

/**
 * `globalThis.localStorage`, or null when the browser refuses it. Reading the
 * property itself throws `SecurityError` when site data is blocked (Safari
 * "Block all cookies", Brave strict), so it is never touched unguarded.
 */
function defaultStorage(): GraduationTxStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The store for one launch. Without Web Storage, with storage that throws, or
 * with a corrupt entry, `load()` is null — an honest "unknown", never a
 * fabricated hash (a corrupt entry is removed, not trusted). Blocked storage
 * must never stop a graduation: the flow still holds the hash in memory and
 * the manual-entry recovery stays available.
 */
export function graduationTxStore(
  launchKey: string,
  storage: GraduationTxStorage | null = defaultStorage(),
): GraduationTxStore {
  const key = `${PREFIX}${launchKey}`;
  return {
    load() {
      if (!storage) return null;
      let stored: string | null;
      try {
        stored = storage.getItem(key);
      } catch {
        return null;
      }
      if (stored === null) return null;
      if (!GRADUATION_TX_HASH_RE.test(stored)) {
        try {
          storage.removeItem(key);
        } catch {
          // Unreadable garbage stays unread; load() still reports unknown.
        }
        return null;
      }
      return stored;
    },
    save(txHash: string) {
      if (!GRADUATION_TX_HASH_RE.test(txHash)) {
        throw new Error(`refusing to persist a malformed tx hash: ${txHash}`);
      }
      // Storage failures propagate: the caller decides whether persistence is
      // best-effort (the flow, after the money call landed) or must be
      // reported (the manual hash-entry form).
      storage?.setItem(key, txHash);
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // Nothing stored is readable either; clearing has nothing to do.
      }
    },
  };
}
