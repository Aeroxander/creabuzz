/**
 * State-machine tests for the passkey identity: what is persisted (never the
 * secret), that unlock re-derives the registered key through the real
 * ceremony/derivation seam, and that a mismatched re-derivation is refused
 * instead of silently adopted.
 *
 * The WebAuthn ceremony is stood in for by the module's dev mock
 * (`sessionStorage["buzz.passkey.mock"]` — same flag as the web-passkey
 * branch); everything below it (HKDF → secp256k1, COSE-shaped owner key,
 * storage posture, match check) is the production code path. The real
 * navigator.credentials surface is exercised in tests/e2e/passkey.spec.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

// node has no web storage — install Map-backed shims before the calls.
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

Object.defineProperty(globalThis, "localStorage", {
  value: fakeStorage(localMap),
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: fakeStorage(sessionMap),
  configurable: true,
});
// Deterministic mock ceremony with PRF output (dev flag, web-passkey parity).
sessionMap.set("buzz.passkey.mock", "1");

const PASSKEY_KEYS = [
  "buzz.passkey.credentialId",
  "buzz.passkey.mode",
  "buzz.passkey.pubkey",
  "buzz.passkey.r1",
  "buzz.passkey.salt",
];

const {
  clearPasskeySession,
  ensureSamePubkey,
  hasPasskeyIdentity,
  isPasskeyActive,
  passkeyIdentity,
  passkeySecretKey,
  passkeyStoredPubkey,
  removePasskeyIdentity,
  setupPasskey,
  signInPasskeyIdentity,
} = await import("./passkey-identity.ts");

function secretKeyHex() {
  const sk = passkeySecretKey();
  assert.ok(sk, "expected an in-memory secret key");
  return Buffer.from(sk).toString("hex");
}

test("registration persists only public material and keeps the key in memory", async () => {
  const registered = await setupPasskey("Test Person");
  assert.equal(registered.mode, "prf");
  assert.equal(registered.identity?.nostr.pubkeyHex, registered.pubkey);
  assert.match(registered.identity?.evmOwner.r1UncompressedHex ?? "", /^04/);

  // Storage posture: credential id + salt + public keys, nothing secret. A
  // secret key persisted under any name fails this list.
  assert.deepEqual([...localMap.keys()].sort(), PASSKEY_KEYS);
  const secretHex = secretKeyHex();
  for (const key of PASSKEY_KEYS) {
    assert.notEqual(
      localMap.get(key),
      secretHex,
      `${key} must not hold the key`,
    );
  }
  assert.equal(localMap.get("buzz.passkey.mode"), "prf");
  assert.equal(localMap.get("buzz.passkey.pubkey"), registered.pubkey);
  assert.equal(
    localMap.get("buzz.passkey.r1"),
    registered.identity?.evmOwner.r1UncompressedHex,
  );
});

test("reload → unlock re-derives the registered identity through the stored record", async () => {
  const registered = await setupPasskey("Test Person");
  const registeredSecretHex = secretKeyHex();
  // A reload drops the page-memory key but keeps the public record.
  clearPasskeySession();
  assert.equal(passkeySecretKey(), null);
  assert.ok(hasPasskeyIdentity());
  assert.equal(isPasskeyActive(), false);
  assert.equal(passkeyStoredPubkey(), registered.pubkey);

  const signedIn = await signInPasskeyIdentity();
  assert.equal(signedIn.pubkey, registered.pubkey);
  assert.ok(isPasskeyActive());
  // Same credential + salt → same key, byte for byte.
  assert.equal(secretKeyHex(), registeredSecretHex);
  const identity = passkeyIdentity();
  assert.equal(identity?.nostr.pubkeyHex, registered.pubkey);
  assert.equal(
    identity?.evmOwner.r1UncompressedHex,
    registered.identity?.evmOwner.r1UncompressedHex,
  );
});

test("a re-derivation that does not match the registered key is refused", async () => {
  await setupPasskey("Test Person");
  clearPasskeySession();
  // Tamper with the public record: unlocking must fail, not adopt the
  // mismatched key (that would sign as a different person silently).
  localMap.set("buzz.passkey.pubkey", "ab".repeat(32));
  await assert.rejects(signInPasskeyIdentity, /different Nostr identity/);
  assert.equal(isPasskeyActive(), false);
  assert.equal(passkeySecretKey(), null);
});

test("removing the passkey clears every stored field (derived metadata included)", async () => {
  await setupPasskey("Test Person");
  assert.deepEqual([...localMap.keys()].sort(), PASSKEY_KEYS);
  removePasskeyIdentity();
  assert.deepEqual([...localMap.keys()], []);
  assert.equal(hasPasskeyIdentity(), false);
  assert.equal(passkeyIdentity(), null);
  assert.equal(passkeyStoredPubkey(), null);
  assert.equal(isPasskeyActive(), false);
});

test("a legacy 4-key record still reads as a passkey, without a wallet-owner root", () => {
  // The shape tests/e2e/multi-user.spec.ts seeds: registration records made
  // before owner capture must keep working for sign-in gating, and must NOT
  // fabricate an r1 key they never had.
  localMap.set("buzz.passkey.credentialId", "cred-1");
  localMap.set("buzz.passkey.salt", "c2FsdA");
  localMap.set("buzz.passkey.pubkey", "e".repeat(64));
  localMap.set("buzz.passkey.mode", "prf");
  assert.equal(hasPasskeyIdentity(), true);
  assert.equal(passkeyStoredPubkey(), "e".repeat(64));
  assert.equal(passkeyIdentity(), null);
  removePasskeyIdentity();
});

test("ensureSamePubkey adopts only an exact match and names both keys", () => {
  const key = "a".repeat(64);
  ensureSamePubkey(key, "a".repeat(64)); // no throw
  try {
    ensureSamePubkey(key, "b".repeat(64));
    assert.fail("mismatch must throw");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    assert.match(message, /different Nostr identity/);
    assert.ok(message.includes(key));
    assert.ok(message.includes("b".repeat(64)));
  }
});
