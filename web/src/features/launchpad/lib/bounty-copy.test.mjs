import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bountyStatusLine,
  deadlineFromDate,
  defaultDeadlineDate,
  waitDays,
} from "./bounty-copy.ts";

const DAVE = "0x00000000000000000000000000000000000000da";
const words = {
  money: (units) => `${units} USDC`,
  date: (seconds) => `day ${seconds}`,
  who: (address) => (address === DAVE ? "Dave" : address),
};
const bounty = {
  mandate: `0x${"11".repeat(20)}`,
  openedAt: 100,
  deadline: 1_000,
  projectId: `0x${"00".repeat(32)}`,
  window: 7 * 86_400,
  refundsFrom: 2_000,
  total: 150n,
  refunded: 0n,
  paidClaim: null,
  contributor: null,
};

test("every stage has its own sentence, naming who and when", () => {
  const cases = [
    [
      { kind: "paid", claimId: "0x1", contributor: DAVE },
      "Paid 150 USDC to Dave.",
    ],
    [
      { kind: "refunds" },
      "No work was approved in time. Everyone can take their money back.",
    ],
    [
      { kind: "payable", claimId: "0x1", contributor: DAVE },
      "Dave's work was approved and the wait is over. Anyone can pay it now.",
    ],
    [
      { kind: "in-window", claimId: "0x1", contributor: DAVE, payableAt: 900 },
      "Dave's work was approved. It can be paid from day 900, unless the DAO stops it before then.",
    ],
    [
      { kind: "open" },
      "Takes money until day 1000. It pays whoever's work for this area the reviewers approve by then, after the 7-day wait.",
    ],
    [
      { kind: "waiting", refundsFrom: 2_000 },
      "No work was approved by day 1000. Everyone can take their money back from day 2000.",
    ],
  ];
  for (const [stage, line] of cases) {
    assert.equal(bountyStatusLine(stage, bounty, words), line, stage.kind);
  }
});

test("the wait is said in whole days and never as zero", () => {
  assert.equal(waitDays(7 * 86_400), "7-day");
  assert.equal(waitDays(3 * 86_400 + 100), "3-day");
  assert.equal(waitDays(60), "1-day");
});

test("a picked date becomes the end of that day, capped at the work area's expiry, and never the past", () => {
  const endOfDay = Math.floor(new Date("2027-03-10T23:59:00").getTime() / 1000);
  assert.equal(deadlineFromDate("2027-03-10", 0, endOfDay + 10), endOfDay);
  assert.equal(deadlineFromDate("2027-03-10", 0, endOfDay - 10), endOfDay - 10);
  assert.equal(deadlineFromDate("2027-03-10", endOfDay, endOfDay + 10), null);
  assert.equal(deadlineFromDate("10/03/2027", 0, endOfDay), null);
  assert.equal(deadlineFromDate("", 0, endOfDay), null);
});

test("the form starts thirty days ahead, or at the work area's expiry when that is sooner", () => {
  const now = Math.floor(new Date("2027-01-01T12:00:00").getTime() / 1000);
  assert.equal(defaultDeadlineDate(now, now + 90 * 86_400), "2027-01-31");
  assert.equal(defaultDeadlineDate(now, now + 5 * 86_400), "2027-01-06");
});
