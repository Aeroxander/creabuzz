import assert from "node:assert/strict";
import { test } from "node:test";

import { platformPasskeyAvailable } from "./platform-passkey.ts";

test("a device that can make a passkey says yes", async () => {
  const probe = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  };
  assert.equal(await platformPasskeyAvailable(probe), true);
});

test("no WebAuthn, no such question, or a no all say no", async () => {
  assert.equal(await platformPasskeyAvailable(undefined, 10), false);
  assert.equal(await platformPasskeyAvailable({}), false);
  assert.equal(
    await platformPasskeyAvailable({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    }),
    false,
  );
});

test("a browser that refuses or never answers is a no, and does not hold the dialog", async () => {
  assert.equal(
    await platformPasskeyAvailable({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => {
        throw new Error("blocked by policy");
      },
    }),
    false,
  );
  assert.equal(
    await platformPasskeyAvailable(
      {
        isUserVerifyingPlatformAuthenticatorAvailable: () =>
          new Promise(() => {}),
      },
      20,
    ),
    false,
  );
  // A call that throws before it returns a promise is a no as well.
  assert.equal(
    await platformPasskeyAvailable({
      isUserVerifyingPlatformAuthenticatorAvailable: () => {
        throw new TypeError("not allowed");
      },
    }),
    false,
  );
});
