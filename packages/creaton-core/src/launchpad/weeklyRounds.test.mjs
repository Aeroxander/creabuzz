import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, encodeParameters, selectorOf } from "./evmAbi.ts";
import {
  encodeBidInRound,
  encodeCancelSell,
  encodeClaimAndLeave,
  encodeSellInRound,
  escrowFor,
  orderOutcome,
  orderSteps,
  priceOfStep,
  readOpenClaims,
  readRounds,
  ROUND_SIGNATURES,
  roundPhase,
  sellerKeeps,
  SETTLE_WINDOW,
  stepAtLeast,
  stepAtMost,
  TOPIC_BID_PLACED,
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
