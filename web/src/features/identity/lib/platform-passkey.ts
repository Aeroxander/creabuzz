/**
 * Whether this device can make a passkey with its own fingerprint, face or PIN. The sign-up dialog uses it to pick which
 * of its two buttons is the green one: a device that can make a passkey leads with "Create with a passkey", any other
 * leads with "Create without a passkey".
 *
 * Never throws and never waits for ever: a browser with no WebAuthn, one that refuses the question, or one that does
 * not answer all read as "no", so the dialog falls back to the way that always works.
 *
 * Alias-free: `platform-passkey.test.mjs` drives it under `node --test`.
 */

/** The part of the browser's `PublicKeyCredential` this asks. */
export interface PasskeyProbe {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
}

/** How long the browser gets to answer before the answer is "no". */
const ANSWER_MS = 1500;

export async function platformPasskeyAvailable(
  probe: PasskeyProbe | undefined = (
    globalThis as { PublicKeyCredential?: PasskeyProbe }
  ).PublicKeyCredential,
  waitMs: number = ANSWER_MS,
): Promise<boolean> {
  try {
    const ask = probe?.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof ask !== "function") return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    });
    try {
      return (await Promise.race([ask.call(probe), silence])) === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
