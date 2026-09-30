/**
 * Golden vectors for the scoring-operator composer, pinned to the CLI.
 *
 * The reference is `crates/buzz-cli/src/commands/trustgraph.rs` — both its
 * test goldens (computed with `cast abi-encode` + `cast keccak`) and its
 * canonical record serialization (serde_json emits keys sorted). Every value
 * below is copied from that file's tests; if this suite passes, a root this
 * composes is a root the CLI's consumers and the onchain hook accept.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { encodeSetScoreRoot } from "./trust-gate.ts";
import {
  composeRootBundle,
  DEFAULT_PROGRAM,
  scoreRootEventParts,
} from "./trustgraph-root.ts";
import { verifyScoreProof } from "./trust-score.ts";

// `trustgraph.rs` tests — goldens computed with `cast abi-encode`/`cast keccak`.
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ONE = "0x0000000000000000000000000000000000000001";
const TWO = "0x0000000000000000000000000000000000000002";
const LEAF_DEAD_5 =
  "7d509c07f0d4edcc2dd1b53aae68677132eb562dcba78e36381b63ccaf66e6ba";
const LEAF_ONE_7 =
  "b39221ace053465ec3453ce2b36430bd138b997ecea25c1043da0c366812b828";
const ROOT_2 =
  "6c14f5a201d551a317b28659230799f758bc2657de1fbc446edcd26413ccb9bf";

test("the two-leaf root and proofs are the CLI's cast-verified goldens", () => {
  const bundle = composeRootBundle({
    scores: [
      { member: DEAD, score: 5 },
      { member: ONE, score: 7 },
    ],
    program: DEFAULT_PROGRAM,
    epoch: "12",
  });
  assert.equal(bundle.root, `0x${ROOT_2}`);
  // The proof entries are the sibling leaves, byte for byte.
  assert.deepEqual(bundle.proofs[ONE.toLowerCase()].proof, [
    `0x${LEAF_DEAD_5}`,
  ]);
  assert.deepEqual(bundle.proofs[DEAD.toLowerCase()].proof, [
    `0x${LEAF_ONE_7}`,
  ]);
  // Proofs-map keys are `0x` + 40 lowercase hex (the web wire convention).
  for (const key of Object.keys(bundle.proofs)) {
    assert.match(key, /^0x[0-9a-f]{40}$/);
  }
});

test("every proof verifies through the consumer's own verifier", () => {
  const bundle = composeRootBundle({
    scores: [
      { member: DEAD, score: 5 },
      { member: ONE, score: 7 },
    ],
    program: DEFAULT_PROGRAM,
    epoch: "12",
  });
  for (const [member, entry] of Object.entries(bundle.proofs)) {
    assert.ok(
      verifyScoreProof(bundle.root, member, entry.score, entry.proof),
      `proof for ${member} must fold to the root the hook's way`,
    );
  }
  // The wrong score does not verify — the proof binds the score.
  assert.ok(
    !verifyScoreProof(
      bundle.root,
      DEAD,
      6,
      bundle.proofs[DEAD.toLowerCase()].proof,
    ),
  );
});

test("input order does not change the root; odd trees still fold", () => {
  const a = [
    { member: DEAD, score: 5 },
    { member: ONE, score: 7 },
    { member: TWO, score: 9 },
  ];
  const shuffled = [a[2], a[0], a[1]];
  const b1 = composeRootBundle({
    scores: a,
    program: DEFAULT_PROGRAM,
    epoch: "1",
  });
  const b2 = composeRootBundle({
    scores: shuffled,
    program: DEFAULT_PROGRAM,
    epoch: "1",
  });
  assert.equal(b1.root, b2.root, "sorted-by-member determinism");
  for (const [member, entry] of Object.entries(b1.proofs)) {
    assert.ok(
      verifyScoreProof(b1.root, member, entry.score, entry.proof),
      `odd-tree proof for ${member}`,
    );
  }
});

test("empty and duplicate score sets are refused", () => {
  assert.throws(
    () =>
      composeRootBundle({ scores: [], program: DEFAULT_PROGRAM, epoch: "1" }),
    /at least one member/,
  );
  assert.throws(
    () =>
      composeRootBundle({
        scores: [
          { member: DEAD, score: 5 },
          { member: DEAD.toUpperCase().replace("0X", "0x"), score: 6 },
        ],
        program: DEFAULT_PROGRAM,
        epoch: "1",
      }),
    /duplicate member/,
  );
  assert.throws(
    () =>
      composeRootBundle({
        scores: [{ member: "not-an-address", score: 1 }],
        program: DEFAULT_PROGRAM,
        epoch: "1",
      }),
    /bad member address/,
  );
});

test("the published record is the CLI's canonical JSON, byte for byte", () => {
  const bundle = composeRootBundle({
    scores: [
      { member: DEAD, score: 5 },
      { member: ONE, score: 7 },
    ],
    program: DEFAULT_PROGRAM,
    epoch: "12",
    indexerUrl: "https://proofs.example/v1/bundle.json",
    anchorBlock: 192,
  });
  const parts = scoreRootEventParts(bundle);
  assert.equal(
    parts.content,
    `{"anchorBlock":192,"epoch":"12","indexerUrl":"https://proofs.example/v1/bundle.json","program":"${DEFAULT_PROGRAM}","root":"0x${ROOT_2}"}`,
  );
  assert.deepEqual(parts.extraTags, [
    ["d", `${DEFAULT_PROGRAM}:12`],
    ["t", "dao-launchpad"],
  ]);
});

test("the minimal record omits the optional fields exactly as the CLI does", () => {
  const parts = scoreRootEventParts({
    program: DEFAULT_PROGRAM,
    root: `0x${ROOT_2}`,
    epoch: "12",
  });
  assert.equal(
    parts.content,
    `{"epoch":"12","program":"${DEFAULT_PROGRAM}","root":"0x${ROOT_2}"}`,
  );
  // Mixed-case roots normalize to lowercase in the record only.
  const upper = scoreRootEventParts({
    program: DEFAULT_PROGRAM,
    root: `0x${ROOT_2.toUpperCase()}`,
    epoch: "12",
  });
  assert.equal(upper.content, parts.content);
  assert.deepEqual(upper.extraTags, parts.extraTags);
});

test("a malformed root or a missing program/epoch is refused before publishing", () => {
  assert.throws(
    () =>
      scoreRootEventParts({
        program: DEFAULT_PROGRAM,
        root: "0x1234",
        epoch: "1",
      }),
    /64 hex/,
  );
  assert.throws(
    () =>
      scoreRootEventParts({ program: " ", root: `0x${ROOT_2}`, epoch: "1" }),
    /required/,
  );
  assert.throws(
    () =>
      scoreRootEventParts({
        program: DEFAULT_PROGRAM,
        root: `0x${ROOT_2}`,
        epoch: "",
      }),
    /required/,
  );
});

test("the gate rotation calldata matches the CLI's pinned encoding", () => {
  // `setScoreRoot(bytes32,uint256)` — selector pinned to `cast sig` in both
  // suites; the CLI test `set_score_root_selector_pinned_to_cast_sig` encodes
  // the same (root, minScore) pair.
  assert.equal(
    encodeSetScoreRoot(`0x${ROOT_2}`, 60n),
    `0x0355f302${ROOT_2}${"0".repeat(62)}3c`,
  );
});
