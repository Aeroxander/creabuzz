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
 * The store for one launch. Without Web Storage, or with a corrupt entry,
 * `load()` is null — an honest "unknown", never a fabricated hash (a corrupt
 * entry is removed, not trusted).
 */
export function graduationTxStore(
  launchKey: string,
  storage: GraduationTxStorage | null = globalThis.localStorage ?? null,
): GraduationTxStore {
  const key = `${PREFIX}${launchKey}`;
  return {
    load() {
      if (!storage) return null;
      const stored = storage.getItem(key);
      if (stored === null) return null;
      if (!GRADUATION_TX_HASH_RE.test(stored)) {
        storage.removeItem(key);
        return null;
      }
      return stored;
    },
    save(txHash: string) {
      if (!GRADUATION_TX_HASH_RE.test(txHash)) {
        throw new Error(`refusing to persist a malformed tx hash: ${txHash}`);
      }
      storage?.setItem(key, txHash);
    },
    clear() {
      storage?.removeItem(key);
    },
  };
}
