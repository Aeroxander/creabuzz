import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ecdsaSign,
  verify as ecdsaVerify,
} from "node:crypto";
import test from "node:test";

import {
  ERC1271_MAGIC,
  isValidKernelSignature,
  isValidSignatureCall,
  KERNEL_WRAPPER_TYPE_HASH,
  kernelWrapHash,
  signKernelHash,
} from "./kernel-signature.ts";
import { b64urlEncode } from "./passkey.ts";
import { keccak256 } from "./userop.ts";

// The repo's pinned fixture passkey (contracts/test/kernel-sign.mjs): obviously fake, only ever used for tests. Its
// Kernel 0.3.3 account is deployed on Sepolia, which is where the wrapped hash below was checked to be accepted.
const JWK = {
  kty: "EC",
  x: "BqjPovesWJOn2eU86PyU1j9LVKlpvYN2w5KCEzAus2Y",
  y: "Ii_D2wwf1j9Rb0hDdPZvMCEM57JNbv48Uk62463QVG4",
  crv: "P-256",
  d: "T4FCxtt1hQgHJSwFv78_S0LGYtVvt73h7-RikHaQ_G8",
};
const key = createPrivateKey({ key: JWK, format: "jwk" });
const publicKey = createPublicKey(key);
const ACCOUNT = "0xd6b93cedda0d95145b822f44108ef13e41e9aa39";
const SEPOLIA = 11155111;
const utf = (text) => `0x${Buffer.from(text).toString("hex")}`;
const HASH = keccak256(utf("creabuzz probe digest"));
// What the account's passkey validator is actually asked about for HASH: accepted by the real account on Sepolia.
const WRAPPED =
  "0x5303883fabad30629d00d35519c0de90a983e8edaafd2b18d5cd5f54f9c85085";

/** The ceremony a passkey performs, with the fixture key: byte for byte what the validator's tests use. */
function ceremony({ credentialId, challenge }) {
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64urlEncode(
    challenge,
  )}","origin":"https://example.com","crossOrigin":false}`;
  const message = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  return Promise.resolve({
    credentialId,
    signature: new Uint8Array(ecdsaSign("sha256", message, key)),
    authenticatorData: new Uint8Array(authenticatorData),
    clientDataJSON: new TextEncoder().encode(clientDataJSON),
  });
}

/** Read back the validator tuple `(bytes, string, uint, uint, uint, bool)` from the part after the `0x00` prefix. */
function readTuple(signature) {
  const bytes = Buffer.from(signature.slice(4), "hex");
  const word = (index) => bytes.subarray(index * 32, index * 32 + 32);
  const number = (index) => BigInt(`0x${word(index).toString("hex")}`);
  const dynamic = (index) => {
    const at = Number(number(index));
    const length = Number(
      BigInt(`0x${bytes.subarray(at, at + 32).toString("hex")}`),
    );
    return bytes.subarray(at + 32, at + 32 + length);
  };
  return {
    authenticatorData: dynamic(0),
    clientDataJSON: dynamic(1).toString("utf8"),
    responseTypeLocation: number(2),
    r: word(3),
    s: word(4),
    usePrecompiled: number(5) === 1n,
  };
}

test("the type hash is the hash of the wrapper Kernel 0.3.3 uses", () => {
  assert.equal(
    keccak256(utf("Kernel(bytes32 hash)")),
    KERNEL_WRAPPER_TYPE_HASH,
  );
});

test("the wrapped hash is pinned to the value the real deployed account accepted", () => {
  assert.equal(kernelWrapHash(HASH, ACCOUNT, SEPOLIA), WRAPPED);
});

test("the wrapped hash depends on the hash, the account and the chain, so a signature cannot be moved", () => {
  const other = `0x${"11".repeat(32)}`;
  const base = kernelWrapHash(HASH, ACCOUNT, SEPOLIA);
  assert.notEqual(kernelWrapHash(other, ACCOUNT, SEPOLIA), base);
  assert.notEqual(kernelWrapHash(HASH, `0x${"22".repeat(20)}`, SEPOLIA), base);
  assert.notEqual(kernelWrapHash(HASH, ACCOUNT, 1), base);
  assert.throws(() => kernelWrapHash("0x1234", ACCOUNT, SEPOLIA));
});

test("signing asks the passkey about the wrapped hash and prefixes the root validator", async () => {
  let asked;
  const signature = await signKernelHash({
    credentialId: "fixture",
    hash: HASH,
    account: ACCOUNT,
    chainId: SEPOLIA,
    getAssertion: (options) => {
      asked = Buffer.from(options.challenge).toString("hex");
      return ceremony(options);
    },
  });
  assert.equal(
    asked,
    WRAPPED.slice(2),
    "the challenge is the wrapped hash, not the hash",
  );
  assert.ok(signature.startsWith("0x00"), "0x00 picks the root validator");
});

test("the signature carries what the validator checks: the challenge, in place, and a signature that verifies", async () => {
  const signature = await signKernelHash({
    credentialId: "fixture",
    hash: HASH,
    account: ACCOUNT,
    chainId: SEPOLIA,
    getAssertion: ceremony,
  });
  const tuple = readTuple(signature);
  // The challenge sits where the validator looks for it (byte 23) and is the wrapped hash.
  assert.equal(tuple.clientDataJSON.indexOf('"challenge":"'), 23);
  const challenge = /"challenge":"([^"]+)"/.exec(tuple.clientDataJSON)[1];
  assert.equal(
    Buffer.from(challenge, "base64url").toString("hex"),
    WRAPPED.slice(2),
  );
  // The ES256 signature verifies under the passkey's public key, as the validator would check it.
  const signed = Buffer.concat([
    tuple.authenticatorData,
    createHash("sha256").update(tuple.clientDataJSON).digest(),
  ]);
  assert.ok(
    ecdsaVerify(
      "sha256",
      signed,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.concat([tuple.r, tuple.s]),
    ),
  );
  assert.equal(tuple.usePrecompiled, false);
});

test("the question put to the account is isValidSignature(hash, signature), and only the magic value is a yes", async () => {
  const signature = `0x00${"ab".repeat(40)}`;
  const data = isValidSignatureCall(HASH, signature);
  assert.ok(
    data.startsWith(ERC1271_MAGIC),
    "the selector of isValidSignature(bytes32,bytes)",
  );
  assert.equal(data.slice(10, 74), HASH.slice(2));

  const asked = [];
  const answer = (value) => (tx) => {
    asked.push(tx);
    return Promise.resolve(value);
  };
  assert.equal(
    await isValidKernelSignature(
      answer(`${ERC1271_MAGIC}${"00".repeat(28)}`),
      ACCOUNT,
      HASH,
      signature,
    ),
    true,
  );
  assert.deepEqual(asked[0], { to: ACCOUNT, data });
  for (const no of [
    `0xffffffff${"00".repeat(28)}`,
    "0x",
    `0x${"00".repeat(32)}`,
  ]) {
    assert.equal(
      await isValidKernelSignature(answer(no), ACCOUNT, HASH, signature),
      false,
      no,
    );
  }
  // An account that reverts has refused.
  assert.equal(
    await isValidKernelSignature(
      () =>
        Promise.reject(
          new Error("chain RPC eth_call failed: execution reverted"),
        ),
      ACCOUNT,
      HASH,
      signature,
    ),
    false,
  );
  // A node that cannot be reached is not a "no": it throws.
  await assert.rejects(
    isValidKernelSignature(
      () => Promise.reject(new Error("offline")),
      ACCOUNT,
      HASH,
      signature,
    ),
    /offline/,
  );
});
