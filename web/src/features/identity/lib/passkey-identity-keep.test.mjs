/**
 * Adding a passkey to an account made without one keeps that account (#4 review).
 *
 * The account's key is stored on this browser; a passkey set up from the account menu, the wallet dialog or the
 * signing-recovery prompt must gate that key and own the payment account, never derive a new, empty person. The
 * ceremony runs through navigator.credentials against a software authenticator with PRF output (`fake-webauthn.mjs`),
 * which is the case that used to switch identities.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installFakeWebAuthn } from "./fake-webauthn.mjs";

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
// identity.ts reads the stored account through window.localStorage.
Object.defineProperty(globalThis, "window", {
  value: { localStorage: local },
  configurable: true,
});
// A software authenticator with PRF output behind the real navigator.credentials path.
installFakeWebAuthn();

const { getPublicKey } = await import("nostr-tools/pure");
const identity = await import("../../../shared/lib/identity.ts");
const {
  exportPasskeyNsec,
  passkeyIdentity,
  passkeyMode,
  passkeyStoredPubkey,
  removePasskeyIdentity,
  setupPasskey,
} = await import("./passkey-identity.ts");

const ACCOUNT_HEX = "11".repeat(32);
const ACCOUNT_PUBKEY = getPublicKey(Buffer.from(ACCOUNT_HEX, "hex"));

function reset() {
  removePasskeyIdentity();
  identity.forgetIdentity();
}

test("a passkey added to a stored account keeps that account and gets a payment-account owner", async () => {
  reset();
  identity.importIdentity(ACCOUNT_HEX);
  assert.equal(identity.existingUserPubkey(), ACCOUNT_PUBKEY);

  const added = await setupPasskey("Mo");

  assert.equal(added.mode, "unlock");
  assert.equal(added.pubkey, ACCOUNT_PUBKEY);
  assert.equal(passkeyStoredPubkey(), ACCOUNT_PUBKEY);
  assert.equal(passkeyMode(), "unlock");
  // The payment account's owner (what passkeyAccountSetup checks first) exists, for the same person.
  const roots = passkeyIdentity();
  assert.ok(roots, "expected the passkey's owner key to be stored");
  assert.equal(roots.nostr.pubkeyHex, ACCOUNT_PUBKEY);
  assert.match(roots.evmOwner.r1UncompressedHex, /^04/);
  assert.equal(added.identity?.nostr.pubkeyHex, ACCOUNT_PUBKEY);
  // The stored key is untouched, and it is still the recovery key (D111).
  assert.equal(identity.storedIdentityHex(), ACCOUNT_HEX);
  assert.equal(exportPasskeyNsec(), ACCOUNT_HEX);
});

test("a new account made with a passkey still derives its key from the passkey", async () => {
  reset();
  assert.equal(identity.existingUserPubkey(), null);

  const made = await setupPasskey("New person");

  assert.equal(made.mode, "prf");
  assert.notEqual(made.pubkey, ACCOUNT_PUBKEY);
  assert.equal(passkeyStoredPubkey(), made.pubkey);
  assert.equal(identity.hasStoredIdentity(), false);
});

test("an unreadable stored account refuses before any passkey is made", async () => {
  reset();
  localMap.set("buzz.identity.nsec", "not-a-key");

  await assert.rejects(
    setupPasskey("Mo"),
    identity.StoredIdentityUnreadableError,
  );
  assert.equal(passkeyStoredPubkey(), null);
  localMap.delete("buzz.identity.nsec");
});
