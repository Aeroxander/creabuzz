/**
 * The way out of the passkey unlock overlay (suite review 2026-11-01, quick win 3): a person whose passkey no longer
 * answers (deleted from the keychain, a broken authenticator) can unlock this session with the recovery key they saved.
 *
 * Driven through the production `passkey-identity` module and `shared/lib/identity` with the dev mock ceremony
 * (`sessionStorage["buzz.passkey.mock"]`), the same set-up as `passkey-identity-keep.test.mjs`. An unlock-mode account
 * is made the way the app makes one: a stored account, then a passkey added to it.
 */

import assert from "node:assert/strict";
import test from "node:test";

const localMap = new Map();
const sessionMap = new Map();

function fakeStorage(map) {
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => void map.clear(),
  };
}

const local = fakeStorage(localMap);
Object.defineProperty(globalThis, "localStorage", {
  value: local,
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: fakeStorage(sessionMap),
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: { localStorage: local },
  configurable: true,
});
sessionMap.set("buzz.passkey.mock", "1");

const { getPublicKey } = await import("nostr-tools/pure");
const identity = await import("../../../shared/lib/identity.ts");
const passkey = await import("./passkey-identity.ts");

const ACCOUNT_HEX = "11".repeat(32);
const ACCOUNT_PUBKEY = getPublicKey(Buffer.from(ACCOUNT_HEX, "hex"));
const OTHER_HEX = "22".repeat(32);

/** An unlock-mode account, locked for this session (as after a reload). */
async function lockedUnlockModeAccount() {
  passkey.removePasskeyIdentity();
  identity.forgetIdentity();
  sessionMap.delete("buzz.passkey.unlocked");
  identity.importIdentity(ACCOUNT_HEX);
  await passkey.setupPasskey("Mo");
  assert.equal(passkey.passkeyMode(), "unlock");
  passkey.clearPasskeySession();
  assert.equal(passkey.isPasskeyActive(), false);
  assert.equal(passkey.isPasskeyUnlocked(), false);
}

test("the account's own recovery key unlocks this session without the passkey", async () => {
  await lockedUnlockModeAccount();

  const result = passkey.unlockWithRecoveryKey(ACCOUNT_HEX);

  assert.equal(result.pubkey, ACCOUNT_PUBKEY);
  assert.equal(passkey.isPasskeyActive(), true);
  assert.equal(passkey.isPasskeyUnlocked(), true);
  // Still the same person, and the passkey stays set up.
  assert.equal(passkey.passkeyStoredPubkey(), ACCOUNT_PUBKEY);
  assert.equal(identity.storedIdentityHex(), ACCOUNT_HEX);
});

test("the recovery key also repairs a browser key that went missing", async () => {
  await lockedUnlockModeAccount();
  identity.forgetIdentity();

  passkey.unlockWithRecoveryKey(ACCOUNT_HEX);

  // Without the stored key, signing would fall through to a brand-new identity.
  assert.equal(identity.storedIdentityHex(), ACCOUNT_HEX);
});

test("another account's key is refused and nothing changes", async () => {
  await lockedUnlockModeAccount();
  assert.equal(typeof passkey.RecoveryKeyMismatchError, "function");

  assert.throws(
    () => passkey.unlockWithRecoveryKey(OTHER_HEX),
    passkey.RecoveryKeyMismatchError,
  );
  assert.equal(passkey.isPasskeyActive(), false);
  assert.equal(passkey.isPasskeyUnlocked(), false);
  assert.equal(identity.storedIdentityHex(), ACCOUNT_HEX);
});

test("a PRF account is not unlocked by a key here (its key comes from the passkey)", async () => {
  passkey.removePasskeyIdentity();
  identity.forgetIdentity();
  sessionMap.delete("buzz.passkey.unlocked");
  await passkey.setupPasskey("Prf");
  assert.equal(passkey.passkeyMode(), "prf");
  passkey.clearPasskeySession();

  assert.throws(() => passkey.unlockWithRecoveryKey(ACCOUNT_HEX), {
    message: /No passkey lock/,
  });
  assert.equal(passkey.isPasskeyActive(), false);
});
