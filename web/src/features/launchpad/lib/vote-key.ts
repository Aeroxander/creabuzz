/**
 * Where a juror's vote key is kept between sealing and opening (D130). The key comes from a wallet signature, but not
 * every wallet signs the same words the same way twice (a passkey's signatures differ each time), so the key used to
 * seal is kept in this browser and can be copied; opening tries it first. Browser storage can be missing or cleared, so
 * every read and write is guarded and a lost key can be pasted back.
 */

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_RE = /^0x[0-9a-f]{64}$/;

export function voteKeyName(
  court: string,
  id: bigint,
  round: number,
  wallet: string,
): string {
  return `creaton:vote-key:${court.toLowerCase()}:${id}:${round}:${wallet.toLowerCase()}`;
}

function storage(): KeyStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Keep the key that sealed a vote. False when this browser could not keep it (then the juror should copy it). */
export function keepVoteKey(
  name: string,
  key: string,
  store: KeyStore | null = storage(),
): boolean {
  try {
    if (!store) return false;
    store.setItem(name, key.toLowerCase());
    return store.getItem(name) === key.toLowerCase();
  } catch {
    return false;
  }
}

export function keptVoteKey(
  name: string,
  store: KeyStore | null = storage(),
): string | null {
  try {
    const value = store?.getItem(name) ?? null;
    return value && KEY_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** A pasted key, tidied, or null when it is not one. */
export function parseVoteKey(text: string): string | null {
  const t = text.trim().toLowerCase();
  const key = t.startsWith("0x") ? t : `0x${t}`;
  return KEY_RE.test(key) ? key : null;
}
