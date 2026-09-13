import assert from "node:assert/strict";
import test from "node:test";

import { scoreStatus, verifyScoreProof } from "./trust-score.ts";

// Golden vectors from `cast keccak 0x…` (the 0x matters: without it cast
// hashes the argument text, not the bytes) and `cast abi-encode`, following
// the exact layout of
// TrustGatedHook.sol: leaf = keccak256(abi.encode(member, score)), path =
// sorted-pair keccak256(node ‖ sibling).
const MEMBER_A = "0x1111111111111111111111111111111111111111";
const MEMBER_B = "0x2222222222222222222222222222222222222222";
const LEAF_A =
  "0x6998bc953403a63dca8534ad8c9b215019442d50a92f45df57582a4e81b414b5";
const LEAF_B =
  "0x6a8325df4268e71e95d23d9717bae1ae3a744607c31b9f50fcf3eb661c624405";
const ROOT_2 =
  "0x1c36d31f306bb88faa658421f428b675afe5a18aad62341744bc0a998f48e91d";
// A single-leaf tree's root is the leaf itself.
const ROOT_1 = LEAF_A;

test("a single-leaf proof verifies against its own root", () => {
  assert.equal(verifyScoreProof(ROOT_1, MEMBER_A, 50, []), true);
});

test("a two-leaf proof verifies in either sibling order (sorted pairs)", () => {
  // Member A is the lower leaf; the verifier must also accept the path
  // presented the other way, because the contract sorts before hashing.
  assert.equal(verifyScoreProof(ROOT_2, MEMBER_A, 50, [LEAF_B]), true);
  assert.equal(verifyScoreProof(ROOT_2, MEMBER_B, 90, [LEAF_A]), true);
});

test("the root is bound to the member and the score", () => {
  // Wrong score for the right member: the leaf differs, so the fold misses.
  assert.equal(verifyScoreProof(ROOT_2, MEMBER_A, 51, [LEAF_B]), false);
  // Right score, wrong member.
  assert.equal(verifyScoreProof(ROOT_2, MEMBER_B, 50, [LEAF_A]), false);
  // Tampered sibling.
  assert.equal(verifyScoreProof(ROOT_2, MEMBER_A, 50, [LEAF_A]), false);
});

test("a malformed root is refused rather than guessed", () => {
  assert.equal(verifyScoreProof("0xdeadbeef", MEMBER_A, 50, []), false);
  assert.equal(verifyScoreProof("", MEMBER_A, 50, []), false);
});

test("scoreStatus reports proven vs unverified and never invents a source", () => {
  const proven = scoreStatus([LEAF_B], ROOT_2, MEMBER_A, 50);
  assert.equal(proven.status, "proven");
  assert.equal(proven.source, ROOT_2);
  const noRoot = scoreStatus([LEAF_B], null, MEMBER_A, 50);
  assert.equal(noRoot.status, "unverified");
  assert.equal(noRoot.source, null);
  const bad = scoreStatus([LEAF_A], ROOT_2, MEMBER_A, 50);
  assert.equal(bad.status, "unverified");
  assert.equal(bad.source, null);
});

test("member casing and 0x prefix do not change the verdict", () => {
  assert.equal(
    verifyScoreProof(ROOT_2.toLowerCase(), MEMBER_A.toUpperCase(), 50, [
      LEAF_B,
    ]),
    true,
  );
});
