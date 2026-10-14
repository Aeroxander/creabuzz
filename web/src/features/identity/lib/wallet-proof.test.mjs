import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  checksumAddress,
  newWalletAttestation,
  recoverWallet,
  resolvePaymentWallet,
  siweMessageHash,
  walletAttestationDigest,
} from "./wallet-proof.ts";

// Public Anvil development key; no user wallet or funds.
const evmKey = hexToBytes(
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const nostrKey = hexToBytes("33".repeat(32));
const pubkey = getPublicKey(nostrKey);
const address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const now = 1800000000;
function proofRecord(patch = {}, time = now) {
  const attestation = newWalletAttestation(address, pubkey, 8453, now, 7);
  const sig = secp256k1.sign(walletAttestationDigest(attestation), evmKey, {
    prehash: false,
    format: "recovered",
  });
  attestation.signature = `0x${bytesToHex(sig.slice(1))}${(sig[0] + 27).toString(16)}`;
  return signBody(
    {
      v: 1,
      address,
      siweMessageHash: siweMessageHash("hello"),
      attestation,
      ...patch,
    },
    time,
  );
}
function signBody(
  body,
  time = now,
  tags = [
    ["d", address],
    ["address", address],
    ["chain", "8453"],
  ],
) {
  return finalizeEvent(
    { kind: 37017, created_at: time, tags, content: JSON.stringify(body) },
    nostrKey,
  );
}
const resolve = (events, time = now) =>
  resolvePaymentWallet(events, pubkey, time);

test("EIP-712 digest agrees with an independent Foundry typed-data signature", () => {
  const proof = newWalletAttestation(
    address,
    "2a".repeat(32),
    8453,
    1768464000,
    123,
  );
  assert.equal(
    bytesToHex(walletAttestationDigest(proof)),
    "e3fee313fa63d2d0f3855817bf54e747e7b972d8a6093d0f4c4cb51efaf09b58",
  );
  // cast wallet sign --data --from-file typed.json --private-key <Anvil account 0>
  assert.equal(
    recoverWallet(
      walletAttestationDigest(proof),
      "0xd9d3c8404c2ac0b69bd7294f702164f5188189dcb543605f9bfe598002bdd8e03bf1575859bce91f141ed2de3949c4fb8ceb44356f9d3f364d2626acc4924bb61c",
    ),
    address,
  );
  assert.equal(
    siweMessageHash("hello"),
    "0x50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750",
  );
  assert.equal(
    checksumAddress(address),
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  );
});

test("a payment identity needs valid signatures from both keys", () => {
  const event = proofRecord();
  assert.equal(resolve([event]).state, "verified");
  assert.equal(resolve([{ ...event, sig: "0".repeat(128) }]).state, "absent");
  const body = JSON.parse(event.content);
  body.attestation.signature = `0x${"00".repeat(65)}`;
  assert.equal(resolve([signBody(body)]).state, "invalid");
  body.attestation = undefined;
  assert.equal(resolve([signBody(body)]).state, "invalid");
});

test("foreign Nostr keys, addresses and chain scopes cannot receive a verified badge", () => {
  for (const change of [
    (body) => {
      body.attestation.attestation.npub[0] ^= 1;
    },
    (body) => {
      body.attestation.attestation.account = `0x${"11".repeat(20)}`;
    },
    (body) => {
      body.attestation.domain.chain_id = 1;
    },
    (body) => {
      body.attestation.domain.name = "foreign";
    },
    (body) => {
      body.address = `0x${"11".repeat(20)}`;
    },
    (body) => {
      body.attestation.attestation.npub[0] = 256;
    },
  ]) {
    const body = JSON.parse(proofRecord().content);
    change(body);
    assert.equal(resolve([signBody(body)]).state, "invalid");
  }
});

test("expired, malformed and revoked newer statements never resurrect an old address", () => {
  const old = proofRecord({}, now - 10);
  const revoked = proofRecord(
    { revoked: true, attestation: undefined },
    now + 1,
  );
  assert.equal(resolve([old, revoked]).state, "revoked");
  const broken = proofRecord({ v: 2 }, now + 2);
  assert.equal(resolve([old, broken]).state, "invalid");
  const expired = proofRecord({}, now + 3);
  assert.equal(resolve([old, expired], now + 366 * 86400).state, "expired");
  assert.equal(resolve([old], now + 365 * 86400).state, "verified");
});

test("ambiguous tags, zero recipients and malformed events fail closed", () => {
  const body = JSON.parse(proofRecord().content);
  assert.equal(
    resolve([
      signBody(body, now, [
        ["d", address],
        ["address", address],
        ["chain", "8453"],
        ["chain", "1"],
      ]),
    ]).state,
    "invalid",
  );
  const zero = `0x${"00".repeat(20)}`;
  assert.equal(
    resolve([
      signBody({ ...body, address: zero }, now, [
        ["d", zero],
        ["address", zero],
        ["chain", "8453"],
      ]),
    ]).state,
    "invalid",
  );
  assert.equal(resolve([{}, null]).state, "absent");
});
