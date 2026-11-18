import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyOutflows, PACE_WINDOW, paceLine, runway } from "./runway.ts";

const DAY = 86_400;
const NOW = 1_000 * DAY;
const BUDGET = `0x${"b1".repeat(20)}`;
const LEAVER = `0x${"1e".repeat(20)}`;
const VENDOR = `0x${"7e".repeat(20)}`;
const EXIT_TX = `0x${"ee".repeat(32)}`;

test("an outflow is set aside, an exit or spent, and only spent counts as spending", () => {
  const sorted = classifyOutflows(
    [
      {
        to: BUDGET.toUpperCase().replace("0X", "0x"),
        amount: 100n,
        tx: null,
        at: NOW,
      },
      { to: LEAVER, amount: 30n, tx: EXIT_TX, at: NOW },
      { to: VENDOR, amount: 20n, tx: `0x${"aa".repeat(32)}`, at: NOW },
      { to: LEAVER, amount: 5n, tx: null, at: NOW },
    ],
    [BUDGET],
    new Set([EXIT_TX]),
  );
  assert.deepEqual(
    sorted.setAside.map((o) => o.amount),
    [100n],
  );
  assert.deepEqual(
    sorted.exits.map((o) => o.amount),
    [30n],
  );
  // The same person paid outside an exit (no burn in that transaction) is spending.
  assert.deepEqual(
    sorted.spent.map((o) => o.amount),
    [20n, 5n],
  );
});

test("the pace needs three months of history and some spending in them, and is never unlimited", () => {
  const base = { free: 900n, setAside: 300n, incomplete: false, now: NOW };
  const cases = [
    [
      "started a day under three months ago",
      {
        ...base,
        bornAt: NOW - PACE_WINDOW + 1,
        spends: [{ amount: 100n, at: NOW }],
      },
      "too-new",
    ],
    [
      "three months exactly, nothing paid",
      { ...base, bornAt: NOW - PACE_WINDOW, spends: [] },
      "no-spending",
    ],
    [
      "only old spending",
      { ...base, bornAt: 0, spends: [{ amount: 100n, at: NOW - PACE_WINDOW }] },
      "no-spending",
    ],
    [
      "spending inside the window",
      {
        ...base,
        bornAt: 0,
        spends: [{ amount: 300n, at: NOW - PACE_WINDOW + 1 }],
      },
      "estimate",
    ],
  ];
  for (const [what, input, kind] of cases) {
    assert.equal(runway(input).pace.kind, kind, what);
  }
});

test("months left is what is on hand over a month of the last three months' spending, rounded down", () => {
  // 1,200 on hand; 600 spent in three months is 200 a month: 6 months.
  const r = runway({
    free: 900n,
    setAside: 300n,
    incomplete: false,
    bornAt: 0,
    now: NOW,
    spends: [
      { amount: 400n, at: NOW - 10 * DAY },
      { amount: 200n, at: NOW - 80 * DAY },
      { amount: 999n, at: NOW - 200 * DAY },
    ],
  });
  assert.deepEqual(r.pace, { kind: "estimate", months: 6 });
  assert.equal(r.spentTotal, 1_599n);
  assert.equal(r.spentRecent, 600n);
  assert.equal(r.incomplete, false);
  // 700 spent: 1,200 × 3 ÷ 700 = 5.14, rounded down.
  assert.equal(
    runway({
      free: 1_200n,
      setAside: 0n,
      incomplete: false,
      bornAt: 0,
      now: NOW,
      spends: [{ amount: 700n, at: NOW }],
    }).pace.months,
    5,
  );
});

test("an undated payment counts in the total but makes the figures incomplete", () => {
  const r = runway({
    free: 0n,
    setAside: 0n,
    incomplete: false,
    bornAt: 0,
    now: NOW,
    spends: [{ amount: 50n, at: null }],
  });
  assert.equal(r.spentTotal, 50n);
  assert.equal(r.spentRecent, 0n);
  assert.equal(r.incomplete, true);
});

test("each pace has its own line", () => {
  assert.equal(
    paceLine({ kind: "too-new" }),
    "Not enough history yet: it started under three months ago.",
  );
  assert.equal(
    paceLine({ kind: "no-spending" }),
    "Nothing was paid out in the last three months, so there is no pace to go by.",
  );
  assert.equal(
    paceLine({ kind: "estimate", months: 1 }),
    "About 1 month at the last three months' pace (an estimate).",
  );
  assert.equal(
    paceLine({ kind: "estimate", months: 0 }),
    "About 0 months at the last three months' pace (an estimate).",
  );
});
