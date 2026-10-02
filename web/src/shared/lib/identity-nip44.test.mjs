/**
 * NIP-44 as the durable identity: two stored identities can exchange an
 * encrypted payload, a passkey override takes precedence over the stored key,
 * and a locked passkey refuses instead of falling through to a fresh key.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as nip44 from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  importIdentity,
  nip44DecryptAsUser,
  nip44EncryptAsUser,
  resetIdentitySecretCache,
} from "./identity.ts";
import {
  setUserNip44Override,
  setUserSigningBlockedReason,
} from "./nostr-signer.ts";

function withIdentity(hex, fn) {
  const map = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
  resetIdentitySecretCache();
  importIdentity(hex);
  return Promise.resolve(fn()).finally(() => {
    setUserNip44Override(null);
    setUserSigningBlockedReason(null);
    resetIdentitySecretCache();
    delete globalThis.window;
  });
}

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

test("a stored identity decrypts what a peer encrypted to it", async () => {
  const mine = generateSecretKey();
  const peer = generateSecretKey();
  const payload = nip44.encrypt(
    "hello",
    nip44.getConversationKey(peer, getPublicKey(mine)),
  );
  await withIdentity(toHex(mine), async () => {
    assert.equal(
      await nip44DecryptAsUser(getPublicKey(peer), payload),
      "hello",
    );
    // And what it encrypts, the peer can read.
    const out = await nip44EncryptAsUser(getPublicKey(peer), "reply");
    assert.equal(
      nip44.decrypt(out, nip44.getConversationKey(peer, getPublicKey(mine))),
      "reply",
    );
  });
});

test("an active passkey override is used instead of the stored key", async () => {
  const stored = generateSecretKey();
  await withIdentity(toHex(stored), async () => {
    setUserNip44Override({
      encrypt: async (peer, text) => `passkey:${peer}:${text}`,
      decrypt: async () => "from-passkey",
    });
    assert.equal(await nip44EncryptAsUser("peer", "x"), "passkey:peer:x");
    assert.equal(await nip44DecryptAsUser("peer", "ct"), "from-passkey");
  });
});

test("an override that answers null (locked) falls through to the stored key", async () => {
  const mine = generateSecretKey();
  const peer = generateSecretKey();
  await withIdentity(toHex(mine), async () => {
    setUserNip44Override({
      encrypt: async () => null,
      decrypt: async () => null,
    });
    const out = await nip44EncryptAsUser(getPublicKey(peer), "x");
    assert.equal(
      nip44.decrypt(out, nip44.getConversationKey(peer, getPublicKey(mine))),
      "x",
    );
  });
});

test("a registered-but-locked passkey blocks instead of using a stored key", async () => {
  await withIdentity(toHex(generateSecretKey()), async () => {
    setUserSigningBlockedReason(
      () => "Unlock your passkey before this browser can sign.",
    );
    await assert.rejects(
      nip44EncryptAsUser(getPublicKey(generateSecretKey()), "x"),
      /Unlock your passkey/,
    );
  });
});
