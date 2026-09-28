/**
 * TrustGate tests — the SAME golden vectors `buzz trustgraph compose-root`
 * pins (computed with `cast abi-encode` + `cast keccak`), so the UI's tree
 * rebuild and the CLI's root can never diverge silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  decodeBytes32Word,
  decodeUintWord,
  encodeSetScoreRoot,
  parseBundleEntries,
  treeLevels,
  SELECTOR_MIN_SCORE,
  SELECTOR_SCORE_ROOT,
  SELECTOR_SET_SCORE_ROOT,
} from "./trust-gate.ts";
import { scoreLeafBytes, verifyScoreProof } from "./trust-score.ts";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ONE = "0x0000000000000000000000000000000000000001";
const TWO = "0x0000000000000000000000000000000000000002";
const LEAF_DEAD_5 =
  "7d509c07f0d4edcc2dd1b53aae68677132eb562dcba78e36381b63ccaf66e6ba";
const LEAF_ONE_7 =
  "b39221ace053465ec3453ce2b36430bd138b997ecea25c1043da0c366812b828";
const ROOT_2 =
  "6c14f5a201d551a317b28659230799f758bc2657de1fbc446edcd26413ccb9bf";

test("selector pins are the cast-derived TrustGatedHook selectors", () => {
  // `cast sig "scoreRoot()"` / `"minScore()"` / `"setScoreRoot(bytes32,uint256)"`
  assert.equal(SELECTOR_SCORE_ROOT, "0x40aa6ee2");
  assert.equal(SELECTOR_MIN_SCORE, "0x13c2bedc");
  assert.equal(SELECTOR_SET_SCORE_ROOT, "0x0355f302");
});

test("golden leaves and root match compose-root (cross-language)", () => {
  assert.equal(bytesToHex(scoreLeafBytes(DEAD, 5)), LEAF_DEAD_5);
  assert.equal(bytesToHex(scoreLeafBytes(ONE, 7)), LEAF_ONE_7);
  // Input order must not matter (sorted-by-member determinism).
  const tree = treeLevels([
    { member: ONE, score: 7 },
    { member: DEAD, score: 5 },
  ]);
  assert.ok(tree);
  assert.equal(tree.root, `0x${ROOT_2}`);
  assert.equal(tree.levels.length, 2);
});

test("every member verifies against the root the hook's way", () => {
  assert.equal(
    verifyScoreProof(`0x${ROOT_2}`, DEAD, 5, [`0x${LEAF_ONE_7}`]),
    true,
  );
  assert.equal(
    verifyScoreProof(`0x${ROOT_2}`, ONE, 7, [`0x${LEAF_DEAD_5}`]),
    true,
  );
  assert.equal(
    verifyScoreProof(`0x${ROOT_2}`, ONE, 8, [`0x${LEAF_DEAD_5}`]),
    false,
    "a wrong score never verifies",
  );
});

test("odd trees carry the last node up and proofs still fold", () => {
  const entries = [
    { member: DEAD, score: 5 },
    { member: ONE, score: 7 },
    { member: TWO, score: 3 },
  ];
  const tree = treeLevels(entries);
  assert.ok(tree);
  assert.equal(tree.levels[0].length, 3, "three leaves");
  assert.equal(tree.levels[1].length, 2, "odd leaf carried up alone");
  // Derive each proof exactly as compose-root does and verify (the hook's fold).
  const sorted = [...entries].sort((a, b) =>
    a.member.toLowerCase() < b.member.toLowerCase() ? -1 : 1,
  );
  sorted.forEach((entry, index) => {
    const path = [];
    let i = index;
    for (let level = 0; level < tree.levels.length - 1; level += 1) {
      const sibling = i ^ 1;
      if (sibling < tree.levels[level].length) {
        path.push(tree.levels[level][sibling]);
      }
      i = Math.floor(i / 2);
    }
    assert.equal(
      verifyScoreProof(tree.root, entry.member, entry.score, path),
      true,
      `proof for ${entry.member} folds to the rebuilt root`,
    );
  });
});

test("duplicate members refuse to build a tree (ambiguous leaves)", () => {
  assert.equal(
    treeLevels([
      { member: ONE, score: 1 },
      { member: ONE, score: 2 },
    ]),
    null,
  );
  assert.equal(treeLevels([]), null);
});

test("encodeSetScoreRoot golden (the rotate-gate rotation)", () => {
  assert.equal(
    encodeSetScoreRoot(`0x${"ab".repeat(32)}`, 42n),
    `0x0355f302${"ab".repeat(32)}${"0".repeat(62)}2a`,
  );
  assert.throws(() => encodeSetScoreRoot("0x1234", 1n));
  assert.throws(() => encodeSetScoreRoot(`0x${"ab".repeat(32)}`, -1n));
  assert.throws(() => encodeSetScoreRoot(`0x${"ab".repeat(32)}`, 1n << 256n));
});

test("return decoders are strict (exactly one word)", () => {
  assert.equal(
    decodeBytes32Word(`0x${"AB".repeat(32)}`),
    `0x${"ab".repeat(32)}`,
  );
  assert.equal(decodeBytes32Word("0x1234"), null);
  assert.equal(decodeBytes32Word(`0x${"ab".repeat(33)}`), null);
  assert.equal(decodeUintWord(`0x${"0".repeat(62)}2a`), 42n);
  assert.equal(decodeUintWord("nope"), null);
});

test("parseBundleEntries drops malformed rows and flags verification", () => {
  const entries = parseBundleEntries(
    {
      [DEAD]: { score: 5, proof: [`0x${LEAF_ONE_7}`] },
      "not-an-address": { score: 1, proof: [] },
      [ONE]: { score: 7, proof: ["0x00"] },
    },
    `0x${ROOT_2}`,
  );
  assert.equal(entries.length, 1, "malformed rows drop, never guessed");
  assert.equal(entries[0].member, DEAD);
  assert.equal(entries[0].verified, true);

  const wrong = parseBundleEntries(
    { [DEAD]: { score: 6, proof: [`0x${LEAF_ONE_7}`] } },
    `0x${ROOT_2}`,
  );
  assert.equal(wrong[0].verified, false, "a wrong score is shown unverified");
});
