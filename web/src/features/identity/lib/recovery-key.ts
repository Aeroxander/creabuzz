/**
 * A recovery key as a person pastes it: the 64 characters this app shows when saving one, or the `nsec1…` form other
 * apps use. Spaces, line breaks and a surrounding quote from copying are ignored. Returns the key as 64 lower-case hex
 * characters, or null when it is not a key.
 */
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

export function parseRecoveryKey(input: string): string | null {
  const text = input.replace(/[\s"'`]/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  if (!text.toLowerCase().startsWith("nsec1")) return null;
  try {
    const decoded = decode(text.toLowerCase());
    if (decoded.type !== "nsec") return null;
    return Array.from(decoded.data, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return null;
  }
}

/** The recovery key a backup may save for an account, or why there is none to save. */
export type RecoveryExport =
  | { kind: "ready"; hex: string }
  /** A passkey account whose key exists only while the passkey is unlocked. */
  | { kind: "locked" }
  /** Nothing in this browser is this account's key. */
  | { kind: "unavailable" };

/**
 * The recovery key for `account`, from where this browser holds it: a PRF passkey's derived key (never the browser key,
 * which then belongs to nobody or to someone else), otherwise the stored browser key. Only a key whose public key is
 * `account` is offered: an empty export, or another identity's key, saved as a backup could not recover this account.
 */
export function recoveryExportFor(
  account: string | null,
  sources: {
    /** How a passkey registered here holds the key, or null without one. */
    passkey: "prf" | "unlock" | null;
    /** A PRF passkey's derived key while unlocked. */
    passkeySecret: string | null;
    /** The browser-stored key, when readable. */
    stored: string | null;
  },
): RecoveryExport {
  if (!account) return { kind: "unavailable" };
  const prf = sources.passkey === "prf";
  const candidate = prf ? sources.passkeySecret : sources.stored;
  if (!candidate) return prf ? { kind: "locked" } : { kind: "unavailable" };
  const hex = parseRecoveryKey(candidate);
  if (!hex) return { kind: "unavailable" };
  return getPublicKey(hexBytes(hex)) === account.toLowerCase()
    ? { kind: "ready", hex }
    : { kind: "unavailable" };
}

/**
 * Whether `account`'s recovery key was saved from this browser. The flag names the account it was saved for; before
 * that it only said "1", which was right for a browser key (that was what got exported) but not for a PRF passkey
 * account, whose export could be empty.
 */
export function backedUpFor(
  flag: string | null,
  account: string | null,
  passkey: "prf" | "unlock" | null,
): boolean {
  if (!account || !flag) return false;
  if (flag === account.toLowerCase()) return true;
  return flag === "1" && passkey !== "prf";
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}
