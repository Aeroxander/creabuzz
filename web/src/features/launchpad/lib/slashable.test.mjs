import assert from "node:assert/strict";
import test from "node:test";

import { slashableReviewers } from "./slashable.ts";

const bond = { decimals: 6, symbol: "USDC" };
const reviewer = (
  address,
  stake,
  pending = null,
  pendingUnreadable = false,
) => ({
  address,
  stake,
  pending,
  pendingUnreadable,
});
const mandate = (address, reviewers, over = {}) => ({
  address,
  bond,
  bondUnreadable: false,
  reviewers,
  ...over,
});

test("a reviewer who asked for the whole bond back is still listed, with the waiting amount and when it can be taken", () => {
  const { entries } = slashableReviewers([
    mandate("0xm", [
      reviewer("0xa", 0n, { amount: 50n, availableAt: 1_900_000_000 }),
    ]),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].active, 0n);
  assert.equal(entries[0].waiting, 50n);
  assert.equal(entries[0].waitingUntil, 1_900_000_000);
  assert.equal(entries[0].total, 50n);
});

test("a partial request counts both parts, and a reviewer with nothing is not listed", () => {
  const { entries } = slashableReviewers([
    mandate("0xm", [
      reviewer("0xa", 30n, { amount: 20n, availableAt: 5 }),
      reviewer("0xb", 0n),
      reviewer("0xc", 70n),
    ]),
  ]);
  assert.deepEqual(
    entries.map((e) => [e.reviewer.address, e.total]),
    [
      ["0xa", 50n],
      ["0xc", 70n],
    ],
  );
});

test("a pending amount that could not be read keeps the reviewer in the list and is flagged, never read as nothing", () => {
  const { entries } = slashableReviewers([
    mandate("0xm", [reviewer("0xa", 0n, null, true)]),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].total, 0n);
  assert.equal(entries[0].waitingUnreadable, true);
});

test("a reviewer whose active stake could not be read still counts what is waiting", () => {
  const { entries } = slashableReviewers([
    mandate("0xm", [reviewer("0xa", null, { amount: 9n, availableAt: 1 })]),
  ]);
  assert.equal(entries[0].total, 9n);
});

test("a budget whose bond terms could not be read cannot list reviewers with a unit, and says so", () => {
  const { entries, unreadableBudgets } = slashableReviewers([
    mandate("0xm", [reviewer("0xa", 10n)], {
      bond: null,
      bondUnreadable: true,
    }),
    mandate("0xn", [reviewer("0xb", 10n)], { bond: null }),
  ]);
  assert.equal(entries.length, 0);
  assert.equal(unreadableBudgets, 1);
});
