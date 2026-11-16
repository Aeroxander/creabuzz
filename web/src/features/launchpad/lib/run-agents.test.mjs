import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { runAgentsOf } from "./run-agents.ts";

const OPERATOR_KEY = "1".repeat(64);
const pub = (key) => bytesToHex(schnorr.getPublicKey(hexToBytes(key)));
const OPERATOR = pub(OPERATOR_KEY);
const SAYS_ONLY = "a".repeat(64);
const VOUCHED = "b".repeat(64);
const PERSON = "c".repeat(64);

function proofFor(agent) {
  const digest = sha256(
    new TextEncoder().encode(`nostr:agent-auth:${agent}:kind=0`),
  );
  return [
    "auth",
    OPERATOR,
    "kind=0",
    bytesToHex(schnorr.sign(digest, hexToBytes(OPERATOR_KEY))),
  ];
}

const profile = (pubkey, tags, created_at = 100) => ({
  kind: 0,
  pubkey,
  created_at,
  tags,
});
const asked = [SAYS_ONLY, VOUCHED, PERSON];

test("a profile that only says agent is a person, as the server counts it", () => {
  assert.deepEqual(
    runAgentsOf([profile(SAYS_ONLY, [["agent", SAYS_ONLY]])], asked),
    [],
  );
});

test("a profile that carries a person's signed word is an agent", () => {
  assert.deepEqual(
    runAgentsOf(
      [
        profile(VOUCHED, [["agent", VOUCHED], proofFor(VOUCHED)]),
        profile(SAYS_ONLY, [["agent", SAYS_ONLY]]),
        profile(PERSON, []),
      ],
      asked,
    ),
    [VOUCHED],
  );
});

test("only the newest profile counts, and only for the accounts asked about", () => {
  const vouched = profile(
    VOUCHED,
    [["agent", VOUCHED], proofFor(VOUCHED)],
    100,
  );
  // A newer profile that drops the proof makes it a person again.
  assert.deepEqual(
    runAgentsOf([vouched, profile(VOUCHED, [["agent", VOUCHED]], 200)], asked),
    [],
  );
  assert.deepEqual(runAgentsOf([vouched], [PERSON]), []);
  // A record of another kind is not a profile.
  assert.deepEqual(runAgentsOf([{ ...vouched, kind: 1 }], asked), []);
});
