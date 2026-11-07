import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedWork,
  capitalPoints,
  DEFAULT_CAPITAL_BLEND,
  participationWeights,
} from "./participation.ts";

const DAY = 86_400;
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const REVIEWER = "e".repeat(64);
const AGENT = "f".repeat(64);

const byWho = (rows) => new Map(rows.map((r) => [r.who, r]));

test("capital points are amount × days, and stop when the money leaves", () => {
  assert.equal(capitalPoints({ who: A, amount: 100, from: 0 }, 10 * DAY), 1000);
  assert.equal(
    capitalPoints({ who: A, amount: 100, from: 0, until: 4 * DAY }, 10 * DAY),
    400,
  );
  // Not committed yet, or nonsense amounts, earn nothing.
  assert.equal(
    capitalPoints({ who: A, amount: 100, from: 20 * DAY }, 10 * DAY),
    0,
  );
  assert.equal(capitalPoints({ who: A, amount: -5, from: 0 }, 10 * DAY), 0);
});

test("staying compounds: the same money committed earlier outweighs it committed later", () => {
  const rows = byWho(
    participationWeights({
      capital: [
        { who: A, amount: 100, from: 0 },
        { who: B, amount: 100, from: 20 * DAY },
      ],
      work: [],
      now: 30 * DAY,
    }),
  );
  assert.equal(rows.get(A).capitalPoints, 3000);
  assert.equal(rows.get(B).capitalPoints, 1000);
  assert.equal(rows.get(A).weight, 0.75);
});

test("nothing decays: someone who stops keeps their points while their share shrinks", () => {
  // A earned 10 in month one and stopped; B keeps earning 10 a month.
  const work = [
    { who: A, points: 10, acceptedAt: 30 * DAY, action: "a1" },
    { who: B, points: 10, acceptedAt: 30 * DAY, action: "b1" },
    { who: B, points: 10, acceptedAt: 60 * DAY, action: "b2" },
    { who: B, points: 10, acceptedAt: 90 * DAY, action: "b3" },
  ];
  const rows = byWho(
    participationWeights({ capital: [], work, now: 90 * DAY }),
  );
  assert.equal(rows.get(A).workPoints, 10, "A's points never go down");
  assert.equal(rows.get(A).weight, 0.25);
  assert.equal(rows.get(B).weight, 0.75);
});

test("the blend mixes capital and work shares, and a missing side hands over its weight", () => {
  const capital = [{ who: A, amount: 100, from: 0 }];
  const work = [{ who: B, points: 5, acceptedAt: DAY, action: "b1" }];
  const both = byWho(
    participationWeights({ capital, work, now: 10 * DAY, capitalBlend: 0.4 }),
  );
  assert.equal(both.get(A).weight, 0.4);
  assert.equal(both.get(B).weight, 0.6);
  const sum = [...both.values()].reduce((s, r) => s + r.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);

  // No raise yet: work carries everything.
  const workOnly = participationWeights({ capital: [], work, now: 10 * DAY });
  assert.equal(workOnly[0].weight, 1);
  // No reviewed work yet: capital carries everything.
  const capitalOnly = participationWeights({
    capital,
    work: [],
    now: 10 * DAY,
  });
  assert.equal(capitalOnly[0].weight, 1);
  assert.equal(DEFAULT_CAPITAL_BLEND, 0.4);
});

test("rows are ordered by weight, then by who, and keys are normalized", () => {
  const rows = participationWeights({
    capital: [],
    work: [
      { who: C, points: 1, acceptedAt: 1, action: "c" },
      { who: B.toUpperCase(), points: 1, acceptedAt: 1, action: "b" },
      { who: A, points: 3, acceptedAt: 1, action: "a" },
    ],
    now: 10,
  });
  assert.deepEqual(
    rows.map((r) => r.who),
    [A, B, C],
  );
});

// ── accepted work from contribution records ────────────────────────────────

let seq = 0;
function record(pubkey, at, d, body) {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    tags: [["d", d]],
    content: JSON.stringify(body),
  };
}
const reviewers = new Set([REVIEWER]);
const isReviewer = (pubkey) => reviewers.has(pubkey);

test("an action counts once a different, authorized reviewer accepts it", () => {
  const work = acceptedWork(
    [
      record(A, 100, "t1", { amount: 40, reviewStatus: "pending" }),
      record(REVIEWER, 200, "t1", { amount: 40, reviewStatus: "accepted" }),
    ],
    isReviewer,
  );
  assert.deepEqual(work, [
    { who: A, points: 40, acceptedAt: 200, action: "t1" },
  ]);
});

test("self-review, unauthorized keys and seated agents never accept anything", () => {
  const work = acceptedWork(
    [
      record(A, 100, "t1", { amount: 40 }),
      record(A, 150, "t1", { amount: 40, reviewStatus: "accepted" }),
      record(B, 160, "t1", { amount: 40, reviewStatus: "accepted" }),
      record(AGENT, 170, "t1", { amount: 40, reviewStatus: "accepted" }),
    ],
    isReviewer,
  );
  assert.deepEqual(work, []);
});

test("a reviewer cannot accept their own work", () => {
  // The claimant holds review authority, so only the self-review rule stops it.
  const work = acceptedWork(
    [
      record(REVIEWER, 100, "t1", { amount: 40 }),
      record(REVIEWER, 150, "t1", { amount: 40, reviewStatus: "accepted" }),
    ],
    isReviewer,
  );
  assert.deepEqual(work, []);
});

test("the newest authorized review decides: accepted then rejected does not count", () => {
  const work = acceptedWork(
    [
      record(A, 100, "t1", { amount: 40 }),
      record(REVIEWER, 200, "t1", { amount: 40, reviewStatus: "accepted" }),
      record(REVIEWER, 300, "t1", { amount: 40, reviewStatus: "rejected" }),
    ],
    isReviewer,
  );
  assert.deepEqual(work, []);
});

test("an edit after acceptance is not paid: the reviewed amount is", () => {
  const work = acceptedWork(
    [
      record(A, 100, "t1", { amount: 40 }),
      // The review did not copy the amount; the claim as it stood counts.
      record(REVIEWER, 200, "t1", { reviewStatus: "accepted" }),
      record(A, 300, "t1", { amount: 4000 }),
    ],
    isReviewer,
  );
  assert.equal(work[0].points, 40);
});

test("a review that copied the amount pays that amount; no amount at all counts 1", () => {
  const copied = acceptedWork(
    [
      record(A, 100, "t1", { amount: 40 }),
      record(REVIEWER, 200, "t1", { amount: 25, reviewStatus: "accepted" }),
    ],
    isReviewer,
  );
  assert.equal(copied[0].points, 25);
  const unpriced = acceptedWork(
    [
      record(A, 100, "t2", { title: "Wrote the onboarding guide" }),
      record(REVIEWER, 200, "t2", { reviewStatus: "accepted" }),
    ],
    isReviewer,
  );
  assert.equal(unpriced[0].points, 1);
});

test("a review older than the filing never counts", () => {
  const work = acceptedWork(
    [
      record(REVIEWER, 50, "t1", { reviewStatus: "accepted" }),
      record(A, 100, "t1", { amount: 40 }),
    ],
    isReviewer,
  );
  assert.deepEqual(work, []);
});
