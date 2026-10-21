import assert from "node:assert/strict";
import test from "node:test";

import {
  moneyInHeadline,
  summariseMoneyIn,
  transfersInFromLogs,
  TRANSFER_TOPIC,
} from "./money-in.ts";

const DAO = `0x${"d0".repeat(20)}`;
const AUCTION = `0x${"ac".repeat(20)}`;
const EXECUTOR = `0x${"e0".repeat(20)}`;
const BUDGET = `0x${"b0".repeat(20)}`;
const LOCK = `0x${"1c".repeat(20)}`;
const TEAM = `0x${"7e".repeat(20)}`;
const topic = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const amount = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

test("the Transfer topic is the ERC-20 event's (cast keccak golden)", () => {
  assert.equal(
    TRANSFER_TOPIC,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
});

test("transfers into the DAO are read from the currency's logs", () => {
  const logs = [
    {
      topics: [TRANSFER_TOPIC, topic(TEAM), topic(DAO)],
      data: amount(500),
      blockNumber: "0x10",
      transactionHash: "0xaa",
    },
    // Not to the DAO, or not a transfer: left out.
    {
      topics: [TRANSFER_TOPIC, topic(DAO), topic(TEAM)],
      data: amount(1),
      blockNumber: "0x11",
      transactionHash: "0xbb",
    },
    {
      topics: ["0x1234", topic(TEAM), topic(DAO)],
      data: amount(1),
      blockNumber: "0x12",
      transactionHash: "0xcc",
    },
  ];
  assert.deepEqual(transfersInFromLogs(logs, DAO), [
    { from: TEAM, amount: 500n, tx: "0xaa", block: 16 },
  ]);
});

test("money in is split into the raise, what came back, and what was paid in", () => {
  const summary = summariseMoneyIn({
    transfers: [
      { from: EXECUTOR, amount: 300_000n, tx: "0x1", block: 1 },
      { from: BUDGET, amount: 2_000n, tx: "0x2", block: 2 },
      { from: LOCK, amount: 50n, tx: "0x3", block: 3 },
      { from: TEAM, amount: 15_000n, tx: "0x4", block: 4 },
      { from: TEAM, amount: 5_000n, tx: "0x5", block: 9 },
    ],
    raise: [AUCTION, EXECUTOR],
    budgets: [BUDGET],
    locks: [LOCK],
  });
  assert.equal(summary.raise, 300_000n);
  assert.equal(summary.fromBudgets, 2_000n);
  assert.equal(summary.fromLocks, 50n);
  assert.equal(summary.paidInTotal, 20_000n);
  assert.deepEqual(
    summary.paidIn.map((t) => t.tx),
    ["0x5", "0x4"],
    "newest first",
  );
  const money = (n) => `${n} USDC`;
  assert.equal(
    moneyInHeadline(summary, money),
    "Besides the raise, 20000 USDC was paid into the treasury in 2 payments.",
  );
  assert.equal(
    moneyInHeadline(
      summariseMoneyIn({ transfers: [], raise: [], budgets: [], locks: [] }),
      money,
    ),
    "Nothing has been paid into the treasury besides the raise yet.",
  );
});
