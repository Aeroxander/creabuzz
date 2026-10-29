import assert from "node:assert/strict";
import test from "node:test";

import {
  passkeyAccountKeys,
  publishedPasskeyAccount,
  rememberedPasskeyAccount,
  rememberPasskeyAccount,
} from "./passkey-account.ts";

const KEY = `04${"ab".repeat(64)}`;
const CRED = "AbCdEfGhIjKlMnOpQrSt_-12";

test("only well-formed public details are taken", () => {
  assert.deepEqual(
    passkeyAccountKeys({
      credentialId: CRED,
      publicKey: `0x${KEY.toUpperCase()}`,
    }),
    {
      credentialId: CRED,
      publicKey: KEY,
    },
  );
  for (const bad of [
    null,
    "x",
    { credentialId: CRED },
    { credentialId: "short", publicKey: KEY },
    { credentialId: CRED, publicKey: `02${"ab".repeat(32)}` },
    { credentialId: "has spaces in it!!", publicKey: KEY },
  ]) {
    assert.equal(passkeyAccountKeys(bad), null);
  }
});

test("kept per person across sign-out, and never another person's", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  rememberPasskeyAccount(
    "alice",
    { credentialId: CRED, publicKey: KEY },
    storage,
  );
  assert.deepEqual(rememberedPasskeyAccount("alice", storage), {
    credentialId: CRED,
    publicKey: KEY,
  });
  assert.equal(rememberedPasskeyAccount("bob", storage), null);
  store.set("buzz.passkey.account:alice", "{not json");
  assert.equal(rememberedPasskeyAccount("alice", storage), null);
});

test("a name link's published copy names the address it must give", () => {
  const address = `0x${"cd".repeat(20)}`;
  assert.deepEqual(
    publishedPasskeyAccount(
      JSON.stringify({
        v: 1,
        address: address.toUpperCase().replace("0X", "0x"),
        passkey: { credentialId: CRED, publicKey: KEY },
      }),
    ),
    { address, keys: { credentialId: CRED, publicKey: KEY } },
  );
  assert.equal(
    publishedPasskeyAccount(JSON.stringify({ v: 1, address })),
    null,
    "an ordinary wallet's link",
  );
  assert.equal(publishedPasskeyAccount("not json"), null);
  assert.equal(
    publishedPasskeyAccount(
      JSON.stringify({
        address: "nope",
        passkey: { credentialId: CRED, publicKey: KEY },
      }),
    ),
    null,
  );
});
