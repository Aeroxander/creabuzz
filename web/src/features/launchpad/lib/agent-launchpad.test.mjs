import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const AUTH_PREFIX = "nostr:agent-auth:";

function toBytes(hex) {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  );
}
function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildAuthTagPure(
  ownerSecretHex,
  ownerPubkeyHex,
  agentPubkey,
  conditions,
) {
  const preimage = `${AUTH_PREFIX}${agentPubkey}:${conditions}`;
  const digest = sha256(new TextEncoder().encode(preimage));
  const sig = schnorr.sign(digest, toBytes(ownerSecretHex));
  return ["auth", ownerPubkeyHex, conditions, toHex(sig)];
}

test("a NIP-OA auth tag verifies with BIP-340 and binds the preimage", () => {
  const OWNER_SECRET = "11".repeat(32);
  const ownerSecret = toBytes(OWNER_SECRET);
  const ownerPubkey = schnorr.getPublicKey(ownerSecret);
  const agentPubkey = "ab".repeat(32);
  const conditions = "";
  const [kind, owner, cond, sigHex] = buildAuthTagPure(
    OWNER_SECRET,
    toHex(ownerPubkey),
    agentPubkey,
    conditions,
  );

  assert.equal(kind, "auth");
  assert.equal(owner, toHex(ownerPubkey));
  assert.equal(cond, conditions);
  assert.equal(sigHex.length, 128);

  // NIP-OA verification: SHA256("nostr:agent-auth:" || agentPubkey || ":" || conditions).
  const preimage = `${AUTH_PREFIX}${agentPubkey}:${conditions}`;
  const digest = sha256(new TextEncoder().encode(preimage));
  assert.equal(
    schnorr.verify(toBytes(sigHex), digest, toBytes(owner)),
    true,
    "the attestation must verify",
  );

  // A different agent pubkey must NOT verify against the same signature.
  const wrongPreimage = `${AUTH_PREFIX}${"cd".repeat(32)}:${conditions}`;
  const wrongDigest = sha256(new TextEncoder().encode(wrongPreimage));
  assert.equal(
    schnorr.verify(toBytes(sigHex), wrongDigest, toBytes(owner)),
    false,
    "the signature must not carry to a different agent",
  );
});
