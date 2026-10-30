import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, encodeParameters, selectorOf } from "./evmAbi.ts";
import {
  encodeBidInRound,
  encodeCancelSell,
  encodeClaimAndLeave,
  encodeSellInRound,
  escrowFor,
  HISTORY_ROUNDS,
  MAX_HISTORY_READS,
  orderOutcome,
  orderSteps,
  priceOfStep,
  readOpenClaims,
  readRoundHistory,
  readRounds,
  ROUND_SIGNATURES,
  roundPhase,
  sellerKeeps,
  SETTLE_WINDOW,
  stepAtLeast,
  stepAtMost,
  TOPIC_BID_PLACED,
  TOPIC_ROUND_OPENED,
  TOPIC_SELL_PLACED,
} from "./weeklyRounds.ts";

const ROUNDS = `0x${"a0".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const SHARES = `0x${"5a".repeat(20)}`;
const ME = `0x${"0e".repeat(20)}`;
const USD = 1_000_000n;
const E18 = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

test("the round's calls and events are the contract's (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(ROUND_SIGNATURES.open), "0xb95460f8");
  assert.equal(sig(ROUND_SIGNATURES.sell), "0xd3c9727c");
  assert.equal(sig(ROUND_SIGNATURES.bid), "0x2ac9bf09");
  assert.equal(sig(ROUND_SIGNATURES.cancelSell), "0x13015684");
  assert.equal(sig(ROUND_SIGNATURES.cancelBid), "0x9703ef35");
  assert.equal(sig(ROUND_SIGNATURES.settle), "0x9a9c29f6");
  assert.equal(sig(ROUND_SIGNATURES.claim), "0xddd5e1b2");
  assert.equal(sig(ROUND_SIGNATURES.claimAndLeave), "0xe39eb49a");
  assert.equal(sig(ROUND_SIGNATURES.rounds), "0x8c65c81f");
  assert.equal(sig(ROUND_SIGNATURES.lastRound), "0x61f6b445");
  assert.equal(sig(ROUND_SIGNATURES.clearingStep), "0xce8acaed");
  assert.equal(
    TOPIC_SELL_PLACED,
    "0xda16a46a24760f2158b3d3dde8302a7c05a3ececa1de06ff0a7303294b42f617",
  );
  assert.equal(
    TOPIC_ROUND_OPENED,
    "0x6a655185e873028ff101c161206d4f48e6f4d6966bbff8a5ac9c28c5011bccb4",
  );
  assert.equal(
    TOPIC_BID_PLACED,
    "0xe0771bb8191f40e2c9380d044dd32271d56e14b7722162d048aa9ebe13eefbb1",
  );
  assert.equal(
    encodeCancelSell(3n, [`0x${"0".repeat(38)}aa`]),
    `0x13015684${word(3)}${word(0x40)}${word(1)}${word(0xaa)}`,
  );
  assert.throws(() => encodeSellInRound(1n, 0n, 0), /above zero/);
  assert.throws(() => encodeBidInRound(1n, 1n, 1024), /outside/);
  assert.throws(() => encodeClaimAndLeave(1n, []), /token to leave with/);
});

test("a price becomes the step a buyer or a seller means, and back", () => {
  const grid = { floor: USD, step: USD / 100n };
  assert.equal(priceOfStep(grid, 30), (130n * USD) / 100n);
  // A buyer's highest price never rounds up past what they said; a seller's lowest never rounds down below it.
  assert.equal(stepAtMost(grid, 1_305_000n), 30);
  assert.equal(stepAtLeast(grid, 1_305_000n), 31);
  assert.equal(stepAtMost(grid, 999_999n), null, "below the floor");
  assert.equal(
    stepAtLeast(grid, 500_000n),
    0,
    "at or below the floor sells at it",
  );
  assert.equal(stepAtMost(grid, 100n * USD), 1023, "capped at the last step");
  assert.equal(stepAtLeast(grid, 100n * USD), null, "above the last step");
  assert.equal(escrowFor(30n * E18, (130n * USD) / 100n), 39n * USD);
  assert.equal(escrowFor(1n, 1n), 1n, "rounded up, as the contract does");
  assert.equal(sellerKeeps(grid, (130n * USD) / 100n), (124n * USD) / 100n);
});

test("a round's phase follows its clock", () => {
  assert.equal(roundPhase({ settled: false, closesAt: 100 }, 99), "bidding");
  assert.equal(roundPhase({ settled: false, closesAt: 100 }, 100), "settling");
  assert.equal(
    roundPhase({ settled: false, closesAt: 100 }, 100 + SETTLE_WINDOW),
    "void",
  );
  assert.equal(roundPhase({ settled: true, closesAt: 100 }, 1e9), "settled");
});

test("orders' outcomes at the price: past it whole, at it a share, beyond it nothing", () => {
  const round = {
    floor: USD,
    step: USD / 100n,
    clearing: {
      step: 30,
      volume: 50n * E18,
      sellersShare: false,
      offeredBelow: 50n * E18,
      wantedAbove: 0n,
    },
    rows: [
      { step: 0, price: USD, offered: 50n * E18, wanted: 60n * E18 },
      {
        step: 30,
        price: (130n * USD) / 100n,
        offered: 50n * E18,
        wanted: 60n * E18,
      },
    ],
  };
  assert.deepEqual(
    orderOutcome(round, "sell", { amount: 50n * E18, step: 0, claimed: false }),
    { units: 50n * E18, money: 62n * USD },
  );
  assert.deepEqual(
    orderOutcome(round, "bid", { amount: 30n * E18, step: 30, claimed: false }),
    { units: 25n * E18, money: (325n * USD) / 10n },
  );
  assert.deepEqual(
    orderOutcome(round, "bid", { amount: 30n * E18, step: 29, claimed: false }),
    { units: 0n, money: 0n },
  );
});

test("the steps people chose come from the placed orders' events", () => {
  const placed = (step) => ({
    topics: [TOPIC_SELL_PLACED, `0x${word(1)}`, `0x${word(BigInt(ME))}`],
    data: encodeParameters(["uint256", "uint256"], [E18, BigInt(step)]),
  });
  assert.deepEqual(orderSteps([placed(30), placed(0), placed(30)]), [0, 30]);
});

test("a DAO's latest round is read with its grid, the price it would settle at, the rows and your orders", async () => {
  const calls = new Map([
    [
      encodeFunctionData(ROUND_SIGNATURES.lastRound, ["address"], [DAO]),
      words(1),
    ],
    [
      encodeFunctionData(ROUND_SIGNATURES.floorOf, ["address"], [DAO]),
      words(USD),
    ],
    [
      encodeFunctionData(ROUND_SIGNATURES.rounds, ["uint256"], [1n]),
      // dao, shares, opensAt, closesAt, floor, step, asked, wanted, settled, sellersShare, price, volume, margin x3
      words(
        BigInt(DAO),
        BigInt(SHARES),
        1000,
        1000 + 3 * 86_400,
        USD,
        USD / 100n,
        50n * E18,
        60n * E18,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ),
    ],
    [
      encodeFunctionData(ROUND_SIGNATURES.clearingStep, ["uint256"], [1n]),
      words(30, 50n * E18, 0),
    ],
    [
      encodeFunctionData(
        ROUND_SIGNATURES.sells,
        ["uint256", "address"],
        [1n, ME],
      ),
      words(50n * E18, 0, 0),
    ],
    [
      encodeFunctionData(
        ROUND_SIGNATURES.bids,
        ["uint256", "address"],
        [1n, ME],
      ),
      words(0, 0, 0),
    ],
  ]);
  const at = (sig, step) =>
    encodeFunctionData(sig, ["uint256", "uint256"], [1n, BigInt(step)]);
  for (const [step, offered, wanted] of [
    [0, 50n * E18, 60n * E18],
    [29, 50n * E18, 60n * E18],
    [30, 50n * E18, 60n * E18],
    [31, 50n * E18, 0n],
  ]) {
    calls.set(at(ROUND_SIGNATURES.supplyAt, step), words(offered));
    calls.set(at(ROUND_SIGNATURES.demandAt, step), words(wanted));
  }
  const chain = {
    call: async (to, data) => {
      assert.equal(to, ROUNDS);
      if (!calls.has(data)) throw new Error(`unexpected ${data}`);
      return calls.get(data);
    },
    logs: async ({ topics }) => {
      assert.equal(BigInt(topics[1]), 1n, "only this round's orders");
      const step = topics[0] === TOPIC_SELL_PLACED ? 0n : 30n;
      return [
        { topics, data: encodeParameters(["uint256", "uint256"], [E18, step]) },
      ];
    },
  };
  const read = await readRounds(chain, ROUNDS, DAO, ME, 2000);
  assert.equal(read.floorNow, USD);
  assert.equal(read.nextOpensAt, 1000 + 7 * 86_400);
  const r = read.round;
  assert.equal(r.phase, "bidding");
  assert.equal(r.shares, SHARES);
  assert.deepEqual(r.clearing, {
    step: 30,
    volume: 50n * E18,
    sellersShare: false,
    offeredBelow: 50n * E18,
    wantedAbove: 0n,
  });
  assert.deepEqual(
    r.rows.map((row) => row.step),
    [0, 30],
  );
  assert.deepEqual(r.mine, {
    sell: { amount: 50n * E18, step: 0, claimed: false },
    bid: null,
  });
  const none = await readRounds(
    { call: async () => words(0), logs: async () => [] },
    ROUNDS,
    DAO,
    null,
    5,
  );
  assert.deepEqual(none, { round: null, nextOpensAt: 5, floorNow: 0n });
});

test("every round with something left to collect is found from the wallet's own orders", async () => {
  const OTHER_DAO = `0x${"0d".repeat(20)}`;
  // Rounds 1 (settled, a bid left), 2 (void, an offer left), 3 (still bidding), 4 (another DAO's).
  const record = (dao, closesAt, settled, funding) =>
    words(
      BigInt(dao),
      BigInt(SHARES),
      0,
      closesAt,
      USD,
      USD / 100n,
      0,
      0,
      settled,
      0,
      0,
      0,
      0,
      0,
      0,
      funding,
      0,
      0,
    );
  const rounds = new Map([
    [1n, record(DAO, 100, 1, 1)],
    [2n, record(DAO, 100, 0, 0)],
    [3n, record(DAO, 1e9, 0, 0)],
    [4n, record(OTHER_DAO, 100, 1, 0)],
  ]);
  const roundsSel = selectorOf(ROUND_SIGNATURES.rounds);
  const sellsSel = selectorOf(ROUND_SIGNATURES.sells);
  const chain = {
    logs: async ({ topics }) => {
      assert.equal(BigInt(topics[2]), BigInt(ME), "only this wallet's orders");
      const ids = topics[0] === TOPIC_BID_PLACED ? [1n, 3n, 4n] : [2n];
      return ids.map((id) => ({
        topics: [topics[0], `0x${word(id)}`, topics[2]],
      }));
    },
    call: async (_to, data) => {
      const id = BigInt(`0x${data.slice(10, 74)}`);
      if (data.startsWith(roundsSel)) return rounds.get(id);
      if (data.startsWith(sellsSel))
        return words(id === 2n ? 5n * E18 : 0, 0, 0);
      return words(id === 2n ? 0 : 3n * E18, 7, 0);
    },
  };
  const claims = await readOpenClaims(chain, ROUNDS, DAO, ME, 1_000_000);
  assert.deepEqual(
    claims.map((c) => [
      c.id,
      c.phase,
      c.funding,
      c.sell?.amount ?? 0n,
      c.bid?.amount ?? 0n,
    ]),
    [
      [2n, "void", false, 5n * E18, 0n],
      [1n, "settled", true, 0n, 3n * E18],
    ],
  );
});

// ---- price history (D147) ----------------------------------------------------------------------------

const DAY = 86_400;
const NOW = 100 * DAY;
const topicWord = (v) => `0x${word(v)}`;

/**
 * A node holding `RoundOpened` logs as the contract emits them, filtering by topic as a real node does, and each round's
 * `rounds(id)` record. Counts the record reads.
 */
function historyChain(list) {
  const logs = list.map((r) => ({
    address: ROUNDS,
    topics: [TOPIC_ROUND_OPENED, topicWord(r.id), topicWord(BigInt(r.dao))],
    data: encodeParameters(
      ["uint256", "uint256", "uint64"],
      [USD, USD / 100n, BigInt(r.closesAt)],
    ),
  }));
  const records = new Map(
    list.map((r) => [
      encodeFunctionData(ROUND_SIGNATURES.rounds, ["uint256"], [r.id]),
      // dao, shares, opensAt, closesAt, floor, step, asked, wanted, settled, sellersShare, price, volume, margin x3,
      // funding, fundingDone, terms
      words(
        BigInt(r.dao),
        BigInt(SHARES),
        r.closesAt - 3 * DAY,
        r.closesAt,
        USD,
        USD / 100n,
        0,
        0,
        r.settled ? 1 : 0,
        0,
        r.step ?? 0,
        r.volume ?? 0n,
        0,
        0,
        0,
        r.funding ? 1 : 0,
        0,
        0,
      ),
    ]),
  );
  const chain = {
    reads: 0,
    call: async (to, data) => {
      assert.equal(to, ROUNDS);
      if (!records.has(data)) throw new Error(`unexpected ${data}`);
      chain.reads += 1;
      return records.get(data);
    },
    logs: async ({ address, topics }) => {
      assert.equal(address, ROUNDS);
      return logs.filter((log) =>
        topics.every(
          (t, i) => t === null || t === undefined || log.topics[i] === t,
        ),
      );
    },
  };
  return chain;
}

test("the last trade is the newest holders' round that traded: not a quiet one, a void one, a funding one or another DAO's", async () => {
  const OTHER_DAO = `0x${"0d".repeat(20)}`;
  const closes = (week) => week * 7 * DAY;
  const chain = historyChain([
    // Round 2 traded 40 Shares at step 10 (1.10 USDC).
    {
      id: 2n,
      dao: DAO,
      closesAt: closes(10),
      settled: true,
      step: 10,
      volume: 40n * E18,
    },
    // Newer: another DAO's trade, a funding round that sold, a void round, a round that traded nothing, one still open.
    {
      id: 5n,
      dao: OTHER_DAO,
      closesAt: closes(11),
      settled: true,
      step: 50,
      volume: E18,
    },
    {
      id: 6n,
      dao: DAO,
      closesAt: closes(11),
      settled: true,
      step: 20,
      volume: 9n * E18,
      funding: true,
    },
    { id: 7n, dao: DAO, closesAt: closes(12), settled: false },
    {
      id: 9n,
      dao: DAO,
      closesAt: closes(13),
      settled: true,
      step: 0,
      volume: 0n,
    },
    { id: 11n, dao: DAO, closesAt: NOW + DAY, settled: false },
  ]);
  const history = await readRoundHistory(chain, ROUNDS, DAO, NOW);
  assert.deepEqual(history.lastTrade, {
    id: 2n,
    closesAt: closes(10),
    outcome: "traded",
    price: (110n * USD) / 100n,
    volume: 40n * E18,
  });
  assert.deepEqual(
    history.rounds.map((r) => [r.id, r.outcome]),
    [
      [9n, "nothing"],
      [7n, "void"],
      [2n, "traded"],
    ],
    "newest first; the open round and the funding round are left out",
  );
  assert.ok(
    history.rounds.every((r) => r.outcome === "traded" || !("price" in r)),
    "a round without a trade never carries a price",
  );
  assert.equal(history.complete, true);
});

test("no last trade before any round has traded", async () => {
  const chain = historyChain([
    { id: 1n, dao: DAO, closesAt: 10 * DAY, settled: true, volume: 0n },
    { id: 2n, dao: DAO, closesAt: 20 * DAY, settled: false },
  ]);
  const history = await readRoundHistory(chain, ROUNDS, DAO, NOW);
  assert.equal(history.lastTrade, null);
  assert.deepEqual(
    history.rounds.map((r) => r.outcome),
    ["void", "nothing"],
  );
  assert.equal(history.complete, true);
  const none = await readRoundHistory(historyChain([]), ROUNDS, DAO, NOW);
  assert.deepEqual(none, { rounds: [], lastTrade: null, complete: true });
});

test("the last trade is found past the listed rounds, and the search is bounded", async () => {
  const quiet = (from, count) =>
    Array.from({ length: count }, (_, i) => ({
      id: BigInt(from + i),
      dao: DAO,
      closesAt: (from + i + 3) * DAY,
      settled: true,
      volume: 0n,
    }));
  const traded = {
    id: 1n,
    dao: DAO,
    closesAt: 4 * DAY,
    settled: true,
    step: 3,
    volume: E18,
  };
  const older = await readRoundHistory(
    historyChain([traded, ...quiet(2, 12)]),
    ROUNDS,
    DAO,
    NOW,
  );
  assert.equal(older.rounds.length, HISTORY_ROUNDS);
  assert.equal(older.lastTrade?.id, 1n, "twelve quiet weeks never hide it");
  assert.equal(older.complete, true);
  const far = historyChain([traded, ...quiet(2, MAX_HISTORY_READS + 5)]);
  const bounded = await readRoundHistory(far, ROUNDS, DAO, NOW);
  assert.equal(far.reads, MAX_HISTORY_READS);
  assert.equal(bounded.lastTrade, null);
  assert.equal(
    bounded.complete,
    false,
    "so the page does not say no trades yet",
  );
});
