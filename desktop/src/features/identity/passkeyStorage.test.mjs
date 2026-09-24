/**
 * Non-secret-storage tests for the desktop passkey record
 * (`./passkeyStorage.ts`) — the guard that no secret material can end up on
 * disk through this module.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  b64ToBytes,
  bytesToB64,
  clearPasskeyState,
  hasPasskeyIdentity,
  loadPasskeyState,
  savePasskeyState,
} from "./passkeyStorage.ts";

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const G_UNCOMPRESSED_HEX =
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";

test("the non-secret record round-trips through storage", () => {
  const storage = fakeStorage();
  const state = {
    credentialId: "AAECAwQFBgcICQoLDA0ODw",
    salt: new Uint8Array([1, 2, 3, 4]),
    pubkey: "489e1b47933dfababa9842058b3a19e2f15cc7f6da0c6f1983688aabe66c2353",
    mode: "prf",
    r1UncompressedHex: G_UNCOMPRESSED_HEX,
    ceremony: { rpId: "app.buzz.example", origin: "https://app.buzz.example" },
  };
  savePasskeyState(state, storage);
  assert.equal(hasPasskeyIdentity(storage), true);
  const loaded = loadPasskeyState(storage);
  assert.deepEqual(loaded, state);
});

test("a record without the r1 root clears the stale r1 key", () => {
  const storage = fakeStorage();
  savePasskeyState(
    {
      credentialId: "abc",
      salt: new Uint8Array([9]),
      pubkey: "pub",
      mode: "unlock",
      r1UncompressedHex: G_UNCOMPRESSED_HEX,
      ceremony: null,
    },
    storage,
  );
  savePasskeyState(
    {
      credentialId: "abc",
      salt: new Uint8Array([9]),
      pubkey: "pub",
      mode: "unlock",
      r1UncompressedHex: null,
      ceremony: null,
    },
    storage,
  );
  const loaded = loadPasskeyState(storage);
  assert.equal(loaded.r1UncompressedHex, null);
  assert.equal(loaded.mode, "unlock");
});

test("the ceremony coupling record is persisted, never invented", () => {
  const storage = fakeStorage();
  // A legacy record (stored before the provenance key existed) loads with
  // `ceremony: null` — the coupling is unknown, not fabricated.
  savePasskeyState(
    {
      credentialId: "abc",
      salt: new Uint8Array([1]),
      pubkey: "pub",
      mode: "prf",
      r1UncompressedHex: null,
      ceremony: null,
    },
    storage,
  );
  assert.equal(loadPasskeyState(storage).ceremony, null);

  // A corrupt provenance value degrades to null too, never a wrong record.
  storage.setItem("buzz.passkey.ceremony", "{not json");
  assert.equal(loadPasskeyState(storage).ceremony, null);
});

test("storage holds only non-secret material", () => {
  const storage = fakeStorage();
  savePasskeyState(
    {
      credentialId: "abc",
      salt: new Uint8Array([1]),
      pubkey: "pub",
      mode: "prf",
      r1UncompressedHex: null,
      ceremony: {
        rpId: "app.buzz.example",
        origin: "https://app.buzz.example",
      },
    },
    storage,
  );
  // The persisted surface is exactly these five keys — no secret-key slot
  // exists, so nothing can leak a secret through this module.
  assert.deepEqual([...storage.map.keys()].sort(), [
    "buzz.passkey.ceremony",
    "buzz.passkey.credentialId",
    "buzz.passkey.mode",
    "buzz.passkey.pubkey",
    "buzz.passkey.salt",
  ]);
});

test("clearing removes the whole record", () => {
  const storage = fakeStorage();
  savePasskeyState(
    {
      credentialId: "abc",
      salt: new Uint8Array([1]),
      pubkey: "pub",
      mode: "prf",
      r1UncompressedHex: G_UNCOMPRESSED_HEX,
      ceremony: {
        rpId: "app.buzz.example",
        origin: "https://app.buzz.example",
      },
    },
    storage,
  );
  clearPasskeyState(storage);
  assert.equal(hasPasskeyIdentity(storage), false);
  assert.equal(loadPasskeyState(storage), null);
});

test("base64 helpers round-trip and accept the base64url alphabet", () => {
  const bytes = new Uint8Array([251, 255, 190, 0, 1]);
  assert.deepEqual([...b64ToBytes(bytesToB64(bytes))], [...bytes]);
  // base64url input (as stored by web's b64urlEncode) decodes too —
  // "-_ _-" maps to the base64 alphabet "+/+/", i.e. bytes fb ff bf.
  assert.deepEqual([...b64ToBytes("-_-_")], [251, 255, 191]);
});
