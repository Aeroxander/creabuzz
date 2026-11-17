/**
 * Who is using the app: the account this browser holds (a passkey or a stored key, `@creaton/core/account`), and
 * whether a passkey account still needs its one tap before it can sign after a reload.
 */
import { existingUserPubkey } from "@creaton/core/client/identity.ts";
import {
  isPasskeyActive,
  onPasskeySessionChange,
  passkeyMode,
} from "@creaton/core/account/passkey-identity.ts";
import { useSyncExternalStore } from "react";

/** Sent on this window whenever an account is made, restored or forgotten here. */
const ACCOUNT_CHANGED_EVENT = "creaton:account-changed";

export function announceAccountChange(): void {
  window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
}

export interface AccountState {
  pubkey: string | null;
  /** A passkey account whose key lives only in memory: one passkey tap before it can sign or open messages. */
  locked: boolean;
}

let cached: AccountState = { pubkey: null, locked: false };

function snapshot(): AccountState {
  const pubkey = existingUserPubkey();
  const locked =
    pubkey !== null && passkeyMode() === "prf" && !isPasskeyActive();
  if (cached.pubkey !== pubkey || cached.locked !== locked)
    cached = { pubkey, locked };
  return cached;
}

function subscribe(listener: () => void): () => void {
  const off = onPasskeySessionChange(listener);
  window.addEventListener(ACCOUNT_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    off();
    window.removeEventListener(ACCOUNT_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

/** The person using the app, or `pubkey: null` when nobody has an account in this browser. */
export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
