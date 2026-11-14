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
    "Apart from the money raised, 20000 USDC was paid in, in 2 payments.",
  );
  assert.equal(
    moneyInHeadline(
      summariseMoneyIn({ transfers: [], raise: [], budgets: [], locks: [] }),
      money,
    ),
    "Apart from the money raised, nothing has been paid in yet.",
  );
});

// ---------------------------------------------------------------------------
// Reading it from the chain: a failed lookup is unknown, never a figure
// ---------------------------------------------------------------------------

const SHARES = `0x${"5a".repeat(20)}`;
const USDC = `0x${"cc".repeat(20)}`;
const word = (a) => `0x${a.slice(2).padStart(64, "0")}`;

/** The raise came in from the executor: 300,000 USDC, and one 1,000 USDC payment from the team. */
function moneyChain(over = {}) {
  const answers = {
    [`${AUCTION} 0x3b6fd2cf`]: word(EXECUTOR), // fundsRecipient()
    [`${SHARES} 0x36bc529d`]: word(LOCK), // lockGuard()
    [`${DAO} 0x03314efa`]: word(SHARES), // shares()
    ...over,
  };
  return {
    async call(to, data) {
      const answer = answers[`${to.toLowerCase()} ${data}`];
      if (answer === undefined) throw new Error("execution reverted");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async logs() {
      return [
        {
          topics: [TRANSFER_TOPIC, topic(EXECUTOR), topic(DAO)],
          data: amount(300_000_000_000n),
          blockNumber: "0x20",
          transactionHash: `0x${"a1".repeat(32)}`,
        },
        {
          topics: [TRANSFER_TOPIC, topic(TEAM), topic(DAO)],
          data: amount(1_000_000_000n),
          blockNumber: "0x30",
          transactionHash: `0x${"a2".repeat(32)}`,
        },
      ];
    },
    async blockTimes(blocks) {
      return new Map(blocks.map((b) => [b, 1_700_000_000 + b]));
    },
  };
}

const input = (over = {}) => ({
  dao: DAO,
  currency: USDC,
  auction: AUCTION,
  shares: SHARES,
  budgets: [],
  ...over,
});

test("the raise from the executor is the raise, and other payments are listed with their date and transaction", async () => {
  const { readMoneyIn } = await import("./money-in.ts");
  const read = await readMoneyIn(moneyChain(), input());
  assert.equal(read.raise, 300_000_000_000n);
  assert.equal(read.paidInTotal, 1_000_000_000n);
  assert.equal(read.paidIn.length, 1);
  assert.equal(read.paidIn[0].tx, `0x${"a2".repeat(32)}`);
  assert.equal(read.paidIn[0].at, 1_700_000_000 + 0x30);
});

test("a failed lookup of where the raise came from is an error, never 300,000 USDC paid in besides it", async () => {
  // The review's case: `fundsRecipient()` did not answer, and the executor's transfer was counted as an extra payment.
  const { readMoneyIn } = await import("./money-in.ts");
  await assert.rejects(
    readMoneyIn(
      moneyChain({ [`${AUCTION} 0x3b6fd2cf`]: new Error("rpc http 503") }),
      input(),
    ),
  );
  await assert.rejects(
    readMoneyIn(
      moneyChain({ [`${SHARES} 0x36bc529d`]: new Error("execution reverted") }),
      input(),
    ),
  );
});

test("Shares not yet known are read from the DAO, so the lock's payments are never counted before it is known", async () => {
  const { readMoneyIn } = await import("./money-in.ts");
  const chain = moneyChain();
  const asked = [];
  const call = chain.call;
  chain.call = (to, data) => {
    asked.push(`${to} ${data}`);
    return call(to, data);
  };
  await readMoneyIn(chain, input({ shares: null }));
  assert.ok(asked.includes(`${DAO} 0x03314efa`), "asks the DAO for its Shares");
  assert.ok(
    asked.includes(`${SHARES} 0x36bc529d`),
    "then the Shares for the lock",
  );
});
