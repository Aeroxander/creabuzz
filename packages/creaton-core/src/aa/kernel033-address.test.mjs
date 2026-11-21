/**
 * The passkey account's address worked out on the device.
 *
 * Provenance of the vector: the runtime code of the deployed Kernel 0.3.3 factory and implementation (the phone loop's
 * `kernel033-stack.json`, read once from the public Sepolia network) was set on a throwaway anvil and the factory's own
 * `getAddress(bytes,bytes32)` asked with the `initialize` calldata of the smoke's obviously-fake fixture key and a zero salt
 * (`cast call`); the local derivation must give the very same address. The app's phone loop checks the same equality against
 * a live factory for a fresh passkey key on every run (`app/tests/anvil/passkey-address.test.ts`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { kernel033AddressLocal } from "./kernel033-address.ts";

const X = 0x06a8cfa2f7ac5893a7d9e53ce8fc94d63f4b54a969bd8376c3928213302eb366n;
const Y = 0x222fc3db0c1fd63f516f484374f66f30210ce7b24d6efe3c524eb6e3add0546en;

test("the address equals the one the deployed factory gave for the fixture key", () => {
  assert.equal(
    kernel033AddressLocal({ pubKeyX: X, pubKeyY: Y }),
    "0xd6b93cedda0d95145b822f44108ef13e41e9aa39",
  );
});

test("another key, another salt, another factory or another implementation is another address", () => {
  const base = kernel033AddressLocal({ pubKeyX: X, pubKeyY: Y });
  const other = [
    kernel033AddressLocal({ pubKeyX: X + 1n, pubKeyY: Y }),
    kernel033AddressLocal({ pubKeyX: X, pubKeyY: Y + 1n }),
    kernel033AddressLocal({
      pubKeyX: X,
      pubKeyY: Y,
      salt: `0x${"00".repeat(31)}01`,
    }),
    kernel033AddressLocal({
      pubKeyX: X,
      pubKeyY: Y,
      factory: "0x2577507b78c2008ff367261cb6285d44ba5ef2e8",
    }),
    kernel033AddressLocal({
      pubKeyX: X,
      pubKeyY: Y,
      implementation: "0xd6cedde84be40893d153be9d467cd6ad37875b29",
    }),
  ];
  for (const address of other) {
    assert.match(address, /^0x[0-9a-f]{40}$/);
    assert.notEqual(address, base);
  }
  assert.equal(new Set(other).size, other.length);
});

test("a factory, implementation or salt that is not well formed is refused", () => {
  assert.throws(() =>
    kernel033AddressLocal({ pubKeyX: X, pubKeyY: Y, factory: "0x12" }),
  );
  assert.throws(() =>
    kernel033AddressLocal({ pubKeyX: X, pubKeyY: Y, implementation: "nope" }),
  );
  assert.throws(() =>
    kernel033AddressLocal({ pubKeyX: X, pubKeyY: Y, salt: "0x01" }),
  );
});
