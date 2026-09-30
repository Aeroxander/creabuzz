import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { deliveryScore } from "./trust-score.ts";

// The shared corpus — the Rust side reads the same file
// (`buzz-cli/commands/trustgraph.rs::delivery_score_matches_the_shared_corpus`),
// so the formula cannot drift between the two implementations silently.
const corpus = JSON.parse(
  readFileSync(
    new URL("../../../../../scripts/trust-score-corpus.json", import.meta.url),
    "utf8",
  ),
);

test("deliveryScore matches every shared corpus case", () => {
  assert.ok(corpus.cases.length > 0);
  for (const c of corpus.cases) {
    assert.equal(deliveryScore(c.inputs), c.score, `case ${c.name}`);
  }
});

test("slashed and rejected claims subtract at tenure scale", () => {
  assert.equal(
    deliveryScore({
      approvedMilestones: 3,
      contributionRecords: 0,
      monthsActive: 12,
      slashedClaims: 1,
      rejectedClaims: 1,
    }),
    1000,
    "3000 good minus 2000 bad at full tenure",
  );
});

test("explicit zero tenure is zero; absent tenure derives or is zero", () => {
  assert.equal(
    deliveryScore({
      approvedMilestones: 5,
      contributionRecords: 2,
      monthsActive: 0,
    }),
    0,
    "monthsActive: 0 is zero tenure — never read as full tenure",
  );
  assert.equal(
    deliveryScore({ approvedMilestones: 1 }),
    0,
    "absent with no timestamps is zero tenure — never a silent 12",
  );
  assert.equal(
    deliveryScore({
      approvedMilestones: 1,
      firstAcceptedAt: 1_600_000_000,
      referenceAt: 1_615_552_000,
    }),
    500,
    "absent derives six whole 30-day months from the first accepted work",
  );
});

test("the floor never goes negative", () => {
  assert.equal(
    deliveryScore({
      approvedMilestones: 0,
      slashedClaims: 5,
      monthsActive: 12,
    }),
    0,
    "clamped at zero",
  );
});
