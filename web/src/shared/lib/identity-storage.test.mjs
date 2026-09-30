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
  existingUserPubkey,
  getOrCreateIdentity,
  hasStoredIdentity,
  identityStorageState,
  importIdentity,
  resetIdentitySecretCache,
  rotateIdentity,
  signAsUser,
  StoredIdentityUnreadableError,
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

test("regression: a stored-but-unreadable identity is never silently replaced", async () => {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  resetIdentitySecretCache();
  try {
    importIdentity(LEGACY); // stores the ncryptsec1 blob + wrap key
    const blobBefore = storage.map.get("buzz.identity.nsec");
    const wrapBefore = storage.map.get("buzz.identity.wrap");
    assert.ok(blobBefore.startsWith("ncryptsec1"), "encrypted blob stored");

    // Simulate a fresh load where the wrap key no longer decrypts the blob.
    resetIdentitySecretCache();
    storage.setItem("buzz.identity.wrap", "ff".repeat(32)); // wrong wrap

    // A blob still exists, so hasStoredIdentity is true...
    assert.equal(hasStoredIdentity(), true);
    // ...but reading it is a hard error, never "nothing stored".
    assert.throws(() => storedIdentityHex(), StoredIdentityUnreadableError);
    assert.equal(identityStorageState(), "unreadable");

    // The create path must refuse to overwrite: signAsUser throws instead of
    // minting a fresh key over the user's real one.
    await assert.rejects(
      () => signAsUser({ kind: 1, tags: [], content: "hi" }),
      StoredIdentityUnreadableError,
    );
    assert.throws(() => getOrCreateIdentity(), StoredIdentityUnreadableError);

    const blobAfter = storage.map.get("buzz.identity.nsec");
    assert.equal(blobAfter, blobBefore, "blobReplaced=false");
    // sameKey=true: restore the wrap and the original identity is intact.
    storage.setItem("buzz.identity.wrap", wrapBefore);
    resetIdentitySecretCache();
    assert.equal(storedIdentityHex(), LEGACY, "sameKey=true");
  } finally {
    resetIdentitySecretCache();
    delete globalThis.window;
  }
});

test("a failed storage write propagates instead of returning a memory-only key", () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: (k) => map.delete(k),
  };
  globalThis.window = { localStorage: storage };
  resetIdentitySecretCache();
  try {
    // Creating the first identity must surface the write failure rather than
    // hand back a key that lives only in memory (gone on reload).
    assert.throws(() => getOrCreateIdentity(), /quota exceeded/);
    assert.equal(map.has("buzz.identity.nsec"), false, "nothing persisted");
    assert.equal(identityStorageState(), "empty", "no phantom in-memory key");
  } finally {
    resetIdentitySecretCache();
    delete globalThis.window;
  }
});

test("an anonymous reader is never minted a key (the presence heartbeat gate)", () => {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  resetIdentitySecretCache();
  try {
    // existingUserPubkey is exactly what use-presence gates the heartbeat on:
    // null for an anonymous visitor means stay invisible, and reading it must
    // not create an identity behind the scenes.
    assert.equal(existingUserPubkey(), null);
    assert.equal(hasStoredIdentity(), false);
    assert.equal(storage.map.size, 0, "anonymous read creates nothing");
  } finally {
    resetIdentitySecretCache();
    delete globalThis.window;
  }
});

test("an unreadable identity is not presented as usable (presence stays invisible)", () => {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  resetIdentitySecretCache();
  try {
    importIdentity(LEGACY);
    resetIdentitySecretCache();
    storage.setItem("buzz.identity.wrap", "ff".repeat(32)); // broken wrap
    assert.equal(
      existingUserPubkey(),
      null,
      "unreadable → no usable identity to announce",
    );
    assert.equal(identityStorageState(), "unreadable");
  } finally {
    resetIdentitySecretCache();
    delete globalThis.window;
  }
});
