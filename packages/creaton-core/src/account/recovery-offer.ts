/**
 * The recovery-key offer made right after a passkey account is created, held outside the sign-up dialog.
 *
 * The dialog that made the account is mounted by whatever asked for it, and several callers mount it only while
 * nobody is signed in: the first re-render after the passkey exists takes their signed-in branch and unmounts it. The
 * offer lives here instead, and one host at the app's root shows it until the person closes it.
 */

export type RecoveryOffer = {
  /** The account just made. */
  account: string;
  /** What the caller wanted once sign-up is finished (a reload, or showing the account menu). */
  onClose: () => void;
};

let current: RecoveryOffer | null = null;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Offer this account's recovery key once; a newer offer replaces one still open. */
export function offerRecoveryKey(offer: RecoveryOffer): void {
  current = offer;
  changed();
}

/** The offer still open, if any. */
export function pendingRecoveryOffer(): RecoveryOffer | null {
  return current;
}

/**
 * Close the offer and run its caller's follow-up. Only the offer that is open closes: a stale close (from a dialog for
 * an offer already replaced) does nothing.
 */
export function closeRecoveryOffer(offer: RecoveryOffer): void {
  if (current !== offer) return;
  current = null;
  changed();
  offer.onClose();
}

export function subscribeRecoveryOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
