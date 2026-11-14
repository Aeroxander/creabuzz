import assert from "node:assert/strict";
import test from "node:test";

import {
  formatShare,
  raiseShare,
  summarizeBids,
  workStanding,
} from "./portfolio.ts";

const Q96 = 2n ** 96n;
const ME = "a".repeat(64);
const BOB = "b".repeat(64);
const REVIEWER = "e".repeat(64);

test("bids sum across wallets: money from the Q96 amount, tokens, open vs exited", () => {
  const summary = summarizeBids([
    { amountQ96: 150n * Q96, tokensFilled: 0n, exitedBlock: 0n },
    { amountQ96: 50n * Q96 + 7n, tokensFilled: 900n, exitedBlock: 1234n },
  ]);
  assert.deepEqual(summary, {
    committed: 200n,
    tokens: 900n,
    open: 1,
    exited: 1,
  });
});

test("raise share is a capped fraction, and unknown when the total is", () => {
  assert.equal(raiseShare(250n, 1000n), 0.25);
  assert.equal(raiseShare(0n, 1000n), 0);
  assert.equal(raiseShare(250n, null), null);
  assert.equal(raiseShare(250n, 0n), null);
  // A stale total never shows more than everything.
  assert.equal(raiseShare(2000n, 1000n), 1);
  // Wei-sized amounts keep precision.
  assert.equal(raiseShare(10n ** 18n, 4n * 10n ** 18n), 0.25);
});

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
const isReviewer = (pk) => pk === REVIEWER;

test("work standing: accepted points and share, and claims still waiting", () => {
  const records = [
    // Mine, accepted at 30 points.
    record(ME, 100, "m1", { amount: 30 }),
    record(REVIEWER, 110, "m1", { amount: 30, reviewStatus: "accepted" }),
    // Mine, waiting for review.
    record(ME, 120, "m2", { amount: 10 }),
    // Mine, rejected: neither accepted nor waiting.
    record(ME, 130, "m3", { amount: 10 }),
    record(REVIEWER, 140, "m3", { amount: 10, reviewStatus: "rejected" }),
    // Mine, "accepted" only by myself: still waiting.
    record(ME, 150, "m4", { amount: 5 }),
    record(ME, 151, "m4", { amount: 5, reviewStatus: "accepted" }),
    // Bob's, accepted at 90 points.
    record(BOB, 100, "b1", { amount: 90 }),
    record(REVIEWER, 110, "b1", { amount: 90, reviewStatus: "accepted" }),
  ];
  const standing = workStanding(records, isReviewer, ME, 1_000);
  assert.equal(standing.points, 30);
  assert.equal(standing.totalPoints, 120);
  assert.equal(standing.share, 0.25);
  assert.equal(standing.accepted, 1);
  assert.equal(standing.waiting, 2);
});

test("a reviewer accepting their own claim leaves it waiting, worth nothing", () => {
  const standing = workStanding(
    [
      record(REVIEWER, 100, "self", { amount: 70 }),
      record(REVIEWER, 101, "self", { amount: 70, reviewStatus: "accepted" }),
    ],
    isReviewer,
    REVIEWER,
    1_000,
  );
  assert.equal(standing.points, 0);
  assert.equal(standing.accepted, 0);
  assert.equal(standing.waiting, 1);
});

test("with no accepted work anywhere, the share is unknown, not zero", () => {
  const standing = workStanding(
    [record(ME, 100, "x", { amount: 1 })],
    isReviewer,
    ME,
    1_000,
  );
  assert.equal(standing.share, null);
  assert.equal(standing.waiting, 1);
});

test("shares read like people write them", () => {
  assert.equal(formatShare(null), "—");
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(0.0004), "<0.1%");
  assert.equal(formatShare(0.0525), "5.3%");
  assert.equal(formatShare(0.25), "25%");
});
