/**
 * The NIP-49 storage migration: the account key never rests in plaintext.
 * Legacy 64-hex values migrate on first read to the encrypted form under the
 * same key, the same logical identity survives the migration and a fresh
 * load, and a reset wipes both the encrypted key and its wrap key before a
 * new identity is minted.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  getOrCreateIdentity,
  hasStoredIdentity,
  importIdentity,
  resetIdentitySecretCache,
  rotateIdentity,
  storedIdentityHex,
} from "./identity.ts";

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function withStorage(fn) {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  resetIdentitySecretCache();
  try {
    fn(storage);
  } finally {
    resetIdentitySecretCache();
    delete globalThis.window;
  }
}

const LEGACY = "ab".repeat(32);
const IMPORTED = "cd".repeat(32);

test("first read migrates the plaintext key to the encrypted form", () => {
  withStorage((storage) => {
    storage.setItem("buzz.identity.nsec", LEGACY);
    assert.equal(hasStoredIdentity(), true);
    const hex = storedIdentityHex();
    assert.equal(hex, LEGACY, "same logical identity");
    const raw = storage.map.get("buzz.identity.nsec");
    assert.ok(
      raw.startsWith("ncryptsec1"),
      "stored value is the encrypted form",
    );
    assert.equal(raw.includes(LEGACY), false);
    assert.ok(storage.map.get("buzz.identity.wrap"), "wrap key exists");
    assert.equal(getOrCreateIdentity(), LEGACY, "reads keep working");
  });
});

test("a fresh load decrypts the encrypted copy back to the same identity", () => {
  withStorage((storage) => {
    storage.setItem("buzz.identity.nsec", LEGACY);
    assert.equal(storedIdentityHex(), LEGACY);
    resetIdentitySecretCache(); // simulate a page reload
    assert.equal(storedIdentityHex(), LEGACY);
  });
});

test("import stores the encrypted form, not plaintext", () => {
  withStorage((storage) => {
    importIdentity(IMPORTED);
    const raw = storage.map.get("buzz.identity.nsec");
    assert.ok(raw.startsWith("ncryptsec1"));
    assert.equal(raw.includes(IMPORTED), false);
    assert.equal(storedIdentityHex(), IMPORTED);
  });
});

test("reset wipes the encrypted identity and wrap key, then mints a new one", () => {
  withStorage((storage) => {
    storage.setItem("buzz.identity.nsec", LEGACY);
    assert.equal(storedIdentityHex(), LEGACY);
    const fresh = rotateIdentity();
    assert.notEqual(fresh, LEGACY);
    assert.notEqual(storedIdentityHex(), LEGACY, "a new identity is minted");
    const raw = storage.map.get("buzz.identity.nsec");
    assert.ok(raw.startsWith("ncryptsec1"), "the new key is stored encrypted");
    assert.ok(storage.map.get("buzz.identity.wrap"), "a wrap key exists again");
  });
});
