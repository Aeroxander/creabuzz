import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  decodeBid,
  decodeClearing,
  decodeListing,
  decodeRound,
  decodeSell,
  encodeBid,
  encodeCancelBid,
  encodeCancelSell,
  encodeClaimQuote,
  encodeClaimShares,
  encodeConfigureListing,
  encodeOpenRound,
  encodeSell,
  encodeSettle,
  lotPriceAt,
  readEarlierRounds,
  readSecondaryMarket,
  roundPhase,
  SECONDARY_BIDDING,
  SECONDARY_EVERY,
  SECONDARY_LOOKBACK,
  SECONDARY_SETTLE_WINDOW,
  SECONDARY_SIGNATURES,
  unsoldLots,
} from "./secondary.ts";

const FACTORY = `0x${"fa".repeat(20)}`;
const MARKET = `0x${"3a".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const WALLET = `0x${"be".repeat(20)}`;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;
const sel = (signature) => selectorOf(SECONDARY_SIGNATURES[signature]);

// The tuples, in the contract's own field order.
const listing = (over = {}) => {
  const v = {
    enabled: 1n,
    minPrice: 1_000_000n,
    maxPrice: 1_064_000n,
    levels: 8n,
    ...over,
  };
  return words(v.enabled, v.minPrice, v.maxPrice, v.levels);
};
const round = (over = {}) => {
  const v = {
    minPrice: 1_000_000n,
    step: 8_000n,
    levels: 8n,
    opensAt: 1_000_000n,
    closesAt: 1_259_200n,
    settleDeadline: 1_432_000n,
    asked: 12n,
    wanted: 9n,
    price: 0n,
    settled: 0n,
    sellersShare: 0n,
    ...over,
  };
  return words(
    v.minPrice,
    v.step,
    v.levels,
    v.opensAt,
    v.closesAt,
    v.settleDeadline,
    v.asked,
    v.wanted,
    v.price,
    v.settled,
    v.sellersShare,
  );
};
const sell = (over = {}) => {
  const v = {
    lots: 4n,
    minStep: 2n,
    filled: 0n,
    orderId: 11n,
    escrowReturned: 0n,
    proceedsPaid: 0n,
    ...over,
  };
  return words(
    v.lots,
    v.minStep,
    v.filled,
    v.orderId,
    v.escrowReturned,
    v.proceedsPaid,
  );
};
const bid = (over = {}) => {
  const v = {
    lots: 3n,
    maxStep: 5n,
    filled: 0n,
    orderId: 12n,
    cancelled: 0n,
    sharesPaid: 0n,
    refundDone: 0n,
    ...over,
  };
  return words(
    v.lots,
    v.maxStep,
    v.filled,
    v.orderId,
    v.cancelled,
    v.sharesPaid,
    v.refundDone,
  );
};

const INPUT = { factory: FACTORY, dao: DAO, wallet: WALLET, now: 1_100_000 };

/** A chain that answers each selector; `over` replaces any answer (or throws in its place). */
function fakeChain(over = {}) {
  const answers = {
    [sel("marketOf")]: () => words(BigInt(MARKET)),
    [sel("listing")]: () => listing(),
    [sel("roundCount")]: () => words(7),
    [sel("rounds")]: () => round(),
    [sel("sells")]: () => sell(),
    [sel("bids")]: () => bid(),
    ...over,
  };
  const calls = [];
  return {
    calls,
    call: async (to, data) => {
      calls.push({ to, data });
      const answer = answers[data.slice(0, 10)];
      if (answer === undefined) {
        throw new Error(`no answer for ${data.slice(0, 10)} on ${to}`);
      }
      return typeof answer === "function" ? answer(to, data) : answer;
    },
  };
}

test("every secondary signature is pinned to cast sig", () => {
  assert.equal(SECONDARY_SIGNATURES.marketOf, "marketOf(address)");
  assert.equal(sel("marketOf"), "0x9d94802b");
  assert.equal(sel("listing"), "0xbc7c55ed");
  assert.equal(sel("rounds"), "0x8c65c81f");
  assert.equal(sel("sells"), "0x06c17d13");
  assert.equal(sel("bids"), "0x3f1ffcec");
  assert.equal(sel("roundCount"), "0x127f0b3f");
  assert.equal(sel("lastOpenAt"), "0x00270ecc");
  assert.equal(sel("priceAt"), "0x01dbdf44");
  assert.equal(sel("clearingOf"), "0x81cefd7f");
  assert.equal(sel("configureListing"), "0x1ecf4419");
  assert.equal(sel("openRound"), "0xe562dfd9");
  assert.equal(sel("sell"), "0x02d91218");
  assert.equal(sel("bid"), "0x1475ac7e");
  assert.equal(sel("cancelSell"), "0x07c9cd45");
  assert.equal(sel("cancelBid"), "0x9703ef35");
  assert.equal(sel("settle"), "0x8df82800");
  assert.equal(sel("claimShares"), "0xace1f5e1");
  assert.equal(sel("claimQuote"), "0x4e0add6a");
  assert.equal(Object.keys(SECONDARY_SIGNATURES).length, 18);
});

test("the contract's windows are the ones the page counts down with", () => {
  assert.equal(SECONDARY_BIDDING, 3 * 86_400);
  assert.equal(SECONDARY_SETTLE_WINDOW, 2 * 86_400);
  assert.equal(SECONDARY_EVERY, 7 * 86_400);
});

test("a DAO with a market reads its listing, its latest round and the wallet's orders", async () => {
  const chain = fakeChain();
  const read = await readSecondaryMarket(chain, INPUT);
  assert.equal(read.kind, "present");
  assert.equal(read.market, MARKET);
  assert.deepEqual(read.listing, {
    enabled: true,
    minPrice: 1_000_000n,
    maxPrice: 1_064_000n,
    levels: 8,
  });
  assert.deepEqual(read.round, {
    minPrice: 1_000_000n,
    step: 8_000n,
    levels: 8,
    opensAt: 1_000_000,
    closesAt: 1_259_200,
    settleDeadline: 1_432_000,
    asked: 12n,
    wanted: 9n,
    price: 0,
    settled: false,
    sellersShare: false,
    phase: "bidding",
    matched: 0n,
  });
  assert.deepEqual(read.wallet, {
    address: WALLET,
    sell: {
      lots: 4n,
      minStep: 2,
      filled: 0n,
      orderId: 11n,
      escrowReturned: false,
      proceedsPaid: false,
    },
    bid: {
      lots: 3n,
      maxStep: 5,
      filled: 0n,
      orderId: 12n,
      cancelled: false,
      sharesPaid: false,
      refundDone: false,
    },
  });
  // The grid prices one lot, as the round froze it.
  assert.equal(lotPriceAt(read.round, 0), 1_000_000n);
  assert.equal(lotPriceAt(read.round, 3), 1_024_000n);
  assert.equal(lotPriceAt(read.round, 8), 1_064_000n);

  // The factory is asked about this DAO; every market question goes to the market.
  assert.deepEqual(chain.calls[0], {
    to: FACTORY,
    data: encodeFunctionData(SECONDARY_SIGNATURES.marketOf, ["address"], [DAO]),
  });
  for (const call of chain.calls.slice(1)) assert.equal(call.to, MARKET);
  assert.deepEqual(
    chain.calls.map((c) => c.data.slice(0, 10)),
    ["marketOf", "listing", "roundCount", "rounds", "sells", "bids"].map(sel),
  );
  assert.deepEqual(
    chain.calls[3].data,
    encodeFunctionData(SECONDARY_SIGNATURES.rounds, ["uint256"], [7n]),
  );
  assert.deepEqual(
    chain.calls[4].data,
    encodeFunctionData(
      SECONDARY_SIGNATURES.sells,
      ["uint256", "address"],
      [7n, WALLET],
    ),
  );
});

test("the zero address is the factory saying it has no market, and nothing else is", async () => {
  const chain = fakeChain({ [sel("marketOf")]: () => words(0) });
  assert.deepEqual(await readSecondaryMarket(chain, INPUT), { kind: "absent" });
  assert.equal(chain.calls.length, 1, "no market calls after an absent answer");
});

test("a read that did not complete is unreadable, never absent", async () => {
  const failures = [
    [
      "a timeout",
      Object.assign(new Error("The chain node did not answer in time."), {
        name: "ChainReadError",
      }),
    ],
    [
      "an unreachable node",
      Object.assign(new Error("Could not reach the chain node."), {
        name: "ChainReadError",
      }),
    ],
    ["a plain transport failure", new TypeError("fetch failed")],
    ["an http refusal", new Error("rpc http 503")],
    // `marketOf` is a mapping getter and cannot revert, and an unlisted DAO is
    // the zero address rather than a refusal. A revert means the address is not
    // this factory, which says nothing about whether the DAO has a market.
    ["a revert", new Error("execution reverted")],
  ];
  for (const [why, error] of failures) {
    const chain = fakeChain({
      [sel("marketOf")]: () => {
        throw error;
      },
    });
    const read = await readSecondaryMarket(chain, INPUT);
    assert.equal(read.kind, "unreadable", `${why} must be unreadable`);
    assert.match(read.reason, new RegExp(error.message.slice(0, 18)));
  }
});

test("an answer that is not one address word is unreadable, not the zero address", async () => {
  for (const bad of [
    "0x",
    "0x1234",
    "not-hex",
    words(1n << 160n), // wider than an address: its low bytes are not one
    words(BigInt(MARKET), 0n),
  ]) {
    const chain = fakeChain({ [sel("marketOf")]: () => bad });
    const read = await readSecondaryMarket(chain, INPUT);
    assert.equal(
      read.kind,
      "unreadable",
      `an answer of ${bad} is not an address`,
    );
  }
});

test("a market answer that is not the tuple is unreadable, never a default", async () => {
  const cases = [
    ["listing", listing().slice(0, 2 + 3 * 64), /not 4 32-byte words/],
    ["roundCount", "0x", /not 1 32-byte words/],
    ["rounds", round().slice(0, 2 + 10 * 64), /not 11 32-byte words/],
    // An empty order answer must not become "this wallet has no offer".
    ["sells", "0x", /not 6 32-byte words/],
    ["bids", "0x", /not 7 32-byte words/],
    ["listing", words(2, 1_000_000n, 1_064_000n, 8n), /not a boolean/],
    ["rounds", round({ levels: 1n << 32n }), /does not fit in 32 bits/],
  ];
  for (const [signature, answer, reason] of cases) {
    const read = await readSecondaryMarket(
      fakeChain({ [sel(signature)]: () => answer }),
      INPUT,
    );
    assert.equal(read.kind, "unreadable", `${signature} answering ${answer}`);
    assert.match(read.reason, reason);
  }
});

test("a market that never opened a round, or whose latest id is unknown, has no round", async () => {
  const never = fakeChain({ [sel("roundCount")]: () => words(0) });
  const first = await readSecondaryMarket(never, INPUT);
  assert.equal(first.kind, "present");
  assert.equal(first.round, null);
  assert.deepEqual(first.wallet, { address: WALLET, sell: null, bid: null });
  assert.equal(
    never.calls.some((c) => c.data.startsWith(sel("rounds"))),
    false,
    "no round id to ask about",
  );

  // `_round` treats a zero `opensAt` as no such round; the getter never reverts.
  const unknown = fakeChain({ [sel("rounds")]: () => round({ opensAt: 0n }) });
  const second = await readSecondaryMarket(unknown, INPUT);
  assert.equal(second.kind, "present");
  assert.equal(second.round, null);
});

test("no wallet means no order reads, and an address with no order reads as null", async () => {
  const none = fakeChain();
  const read = await readSecondaryMarket(none, { ...INPUT, wallet: null });
  assert.equal(read.kind, "present");
  assert.deepEqual(read.wallet, { address: null, sell: null, bid: null });
  assert.equal(
    none.calls.some(
      (c) => c.data.startsWith(sel("sells")) || c.data.startsWith(sel("bids")),
    ),
    false,
  );

  // A cancelled offer is deleted by `cancelSell`, so zero lots is "no offer".
  const noSell = fakeChain({ [sel("sells")]: () => words(0, 0, 0, 0, 0, 0) });
  const orders = await readSecondaryMarket(noSell, INPUT);
  assert.equal(orders.kind, "present");
  assert.equal(orders.wallet.sell, null);
  assert.equal(orders.wallet.bid.lots, 3n);
});

test("a round's phase across every boundary the contract draws", () => {
  const r = { settled: false, closesAt: 1_000, settleDeadline: 172_800 };
  assert.equal(roundPhase(null, 0), "none", "no round at all");
  assert.equal(roundPhase(r, 0), "bidding");
  assert.equal(roundPhase(r, 999), "bidding");
  // `block.timestamp >= closesAt` refuses orders and allows settle: the round
  // is waiting to settle from this exact second.
  assert.equal(roundPhase(r, 1_000), "settling");
  assert.equal(roundPhase(r, 172_799), "settling");
  // `voided` is `!settled && now >= settleDeadline`, so the deadline itself is void.
  assert.equal(roundPhase(r, 172_800), "void");
  assert.equal(roundPhase(r, 999_999), "void");
  // Settled wins over the deadline: a round settled in time stays settled.
  assert.equal(roundPhase({ ...r, settled: true }, 999_999), "settled");
  assert.equal(roundPhase({ ...r, settled: true }, 0), "settled");
});

test("each tuple decoder is strict about its word count and widths", () => {
  assert.deepEqual(decodeListing(listing()), {
    enabled: true,
    minPrice: 1_000_000n,
    maxPrice: 1_064_000n,
    levels: 8,
  });
  assert.deepEqual(decodeRound(round()), {
    minPrice: 1_000_000n,
    step: 8_000n,
    levels: 8,
    opensAt: 1_000_000,
    closesAt: 1_259_200,
    settleDeadline: 1_432_000,
    asked: 12n,
    wanted: 9n,
    price: 0,
    settled: false,
    sellersShare: false,
  });
  assert.deepEqual(decodeSell(sell()), {
    lots: 4n,
    minStep: 2,
    filled: 0n,
    orderId: 11n,
    escrowReturned: false,
    proceedsPaid: false,
  });
  assert.deepEqual(decodeBid(bid()), {
    lots: 3n,
    maxStep: 5,
    filled: 0n,
    orderId: 12n,
    cancelled: false,
    sharesPaid: false,
    refundDone: false,
  });
  assert.deepEqual(decodeClearing(words(3, 12, 1)), {
    level: 3,
    matched: 12n,
    sellersShare: true,
  });

  assert.throws(() => decodeListing(words(1, 2, 3)), /not 4 32-byte words/);
  assert.throws(
    () => decodeListing(words(1, 2, 3, 4, 5)),
    /not 4 32-byte words/,
  );
  assert.throws(() => decodeListing("0x"), /not 4 32-byte words/);
  assert.throws(
    () => decodeRound(round().slice(0, 2 + 10 * 64)),
    /not 11 32-byte words/,
  );
  assert.throws(() => decodeSell(words(1, 2, 3, 4, 5)), /not 6 32-byte words/);
  assert.throws(
    () => decodeBid(words(1, 2, 3, 4, 5, 6)),
    /not 7 32-byte words/,
  );
  assert.throws(() => decodeClearing(words(1, 2)), /not 3 32-byte words/);

  // A word too wide for its field, or a bool that is not 0 or 1, is not this tuple.
  assert.throws(
    () => decodeListing(words(1, 1n << 128n, 2, 1)),
    /minPrice does not fit in 128 bits/,
  );
  assert.throws(
    () => decodeRound(round({ levels: 1n << 32n })),
    /levels does not fit in 32 bits/,
  );
  assert.throws(
    () => decodeRound(round({ settled: 2n })),
    /settled is not a boolean/,
  );
  assert.throws(
    () => decodeSell(sell({ orderId: 1n << 64n })),
    /orderId does not fit in 64 bits/,
  );
  assert.throws(
    () => decodeBid(bid({ maxStep: 1n << 16n })),
    /maxStep does not fit in 16 bits/,
  );
});

test("the DAO's listing terms are the contract's configureListing", () => {
  const of = (values) =>
    encodeFunctionData(
      SECONDARY_SIGNATURES.configureListing,
      ["bool", "uint128", "uint128", "uint32"],
      values,
    );
  assert.equal(
    encodeConfigureListing({
      market: MARKET,
      enabled: true,
      minPrice: 1_000_000n,
      maxPrice: 1_064_000n,
      levels: 8,
    }),
    of([true, 1_000_000n, 1_064_000n, 8n]),
  );
  // Disabling writes zeroed terms; the contract ignores the values, so they are not checked.
  assert.equal(
    encodeConfigureListing({
      market: MARKET,
      enabled: false,
      minPrice: 0n,
      maxPrice: 0n,
      levels: 0,
    }),
    of([false, 0n, 0n, 0n]),
  );

  const on = (over) =>
    encodeConfigureListing({
      market: MARKET,
      enabled: true,
      minPrice: 1_000_000n,
      maxPrice: 1_064_000n,
      levels: 8,
      ...over,
    });
  assert.throws(() => on({ minPrice: 0n }), /lowest price must be above zero/);
  assert.throws(
    () => on({ maxPrice: 1_000_000n }),
    /highest price must be above the lowest/,
  );
  assert.throws(() => on({ levels: 0 }), /1 to 64 levels/);
  assert.throws(() => on({ levels: 65 }), /1 to 64 levels/);
  // The contract requires every grid level to be an integer.
  assert.throws(() => on({ maxPrice: 1_064_001n }), /whole grid steps/);
  assert.throws(() => on({ market: "nope" }), /not an address/);
});

test("a holder's actions are the contract's calls", () => {
  const of = (signature, types, values) =>
    encodeFunctionData(SECONDARY_SIGNATURES[signature], types, values);
  assert.equal(encodeOpenRound(MARKET), sel("openRound"));
  assert.equal(
    encodeSell(MARKET, 7n, 4n, 2),
    of("sell", ["uint256", "uint128", "uint16"], [7n, 4n, 2n]),
  );
  assert.equal(
    encodeBid(MARKET, 7n, 3n, 5),
    of("bid", ["uint256", "uint128", "uint16"], [7n, 3n, 5n]),
  );
  assert.equal(
    encodeCancelSell(MARKET, 7n),
    of("cancelSell", ["uint256"], [7n]),
  );
  assert.equal(encodeCancelBid(MARKET, 7n), of("cancelBid", ["uint256"], [7n]));
  assert.equal(encodeSettle(MARKET, 7n), of("settle", ["uint256"], [7n]));
  assert.equal(
    encodeClaimShares(MARKET, 7n, WALLET),
    of("claimShares", ["uint256", "address"], [7n, WALLET]),
  );
  assert.equal(
    encodeClaimQuote(MARKET, 7n, WALLET),
    of("claimQuote", ["uint256", "address"], [7n, WALLET]),
  );
  // A checksummed wallet is encoded as the same address.
  assert.equal(
    encodeClaimQuote(MARKET, 7n, WALLET.toUpperCase().replace("0X", "0x")),
    of("claimQuote", ["uint256", "address"], [7n, WALLET]),
  );

  assert.throws(() => encodeSell(MARKET, 7n, 0n, 2), /1 to .* whole lots/);
  assert.throws(
    () => encodeSell(MARKET, 7n, (1n << 96n) + 1n, 2),
    /1 to .* whole lots/,
  );
  assert.throws(() => encodeBid(MARKET, 7n, 1n, 65_536), /16 bits/);
  assert.throws(() => encodeClaimShares(MARKET, 7n, "nope"), /not an address/);
  assert.throws(() => encodeSettle("nope", 7n), /not an address/);
});

// ---- earlier rounds ----------------------------------------------------------------------------------------------

/** The round id a call names: its first argument word. */
const idOf = (data) => BigInt(`0x${data.slice(10, 74)}`);

/**
 * A market whose rounds each open a week after the last. `orders` says which rounds the wallet has an
 * offer (`s`) or a bid (`b`) in, and `settled` which rounds settled; the rest are past their deadline at `now`.
 */
function marketOfRounds(orders, settled = [], matchedBy = {}) {
  const calls = [];
  const week = 7 * 86_400;
  return {
    calls,
    call: async (to, data) => {
      calls.push({ to, data });
      const id = idOf(data);
      const sig = data.slice(0, 10);
      const opensAt = BigInt(1_000_000) + (id - 1n) * BigInt(week);
      if (sig === sel("rounds")) {
        return round({
          opensAt,
          closesAt: opensAt + BigInt(SECONDARY_BIDDING),
          settleDeadline:
            opensAt + BigInt(SECONDARY_BIDDING + SECONDARY_SETTLE_WINDOW),
          settled: settled.includes(Number(id)) ? 1n : 0n,
        });
      }
      // A settled round's result: nothing crossed unless the test says lots did.
      if (sig === sel("clearingOf"))
        return words(0, matchedBy[Number(id)] ?? 0, 0);
      const mine = orders[Number(id)] ?? {};
      if (sig === sel("sells"))
        return mine.s ? sell(mine.s) : words(0, 0, 0, 0, 0, 0);
      if (sig === sel("bids"))
        return mine.b ? bid(mine.b) : words(0, 0, 0, 0, 0, 0, 0);
      throw new Error(`no answer for ${sig}`);
    },
  };
}

const LATER = 1_000_000 + 40 * 86_400;

test("a wallet's earlier rounds are read by their own ids, newest first, and rounds it never joined are left out", async () => {
  const chain = marketOfRounds(
    {
      3: { s: { lots: 2n } },
      2: {},
      1: { b: { lots: 3n, maxStep: 4n, filled: 1n }, s: { lots: 1n } },
    },
    [1],
  );
  const read = await readEarlierRounds(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 4n,
    now: LATER,
  });
  assert.deepEqual(
    read.rounds.map((r) => [r.id, r.round.phase]),
    [
      [3n, "void"],
      [1n, "settled"],
    ],
  );
  assert.equal(read.rounds[0].sell.lots, 2n);
  assert.equal(read.rounds[0].bid, null);
  assert.equal(read.rounds[1].bid.lots, 3n);
  assert.equal(read.rounds[1].sell.lots, 1n);
  assert.equal(read.unchecked, 0n);
  // The latest round is the market read's, never this one's: only ids 1..3 are asked about.
  assert.deepEqual([...new Set(chain.calls.map((c) => idOf(c.data)))].sort(), [
    1n,
    2n,
    3n,
  ]);
});

test("the look-back is bounded, and the rounds it did not look at are counted, not hidden", async () => {
  const chain = marketOfRounds({ 4: { s: {} }, 3: { s: {} } });
  const read = await readEarlierRounds(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 12n,
    now: LATER,
  });
  assert.equal(SECONDARY_LOOKBACK, 8);
  assert.equal(chain.calls.length, 3 * SECONDARY_LOOKBACK);
  assert.deepEqual(
    [...new Set(chain.calls.map((c) => idOf(c.data)))].sort((a, b) =>
      a < b ? -1 : 1,
    ),
    [4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n],
  );
  assert.deepEqual(
    read.rounds.map((r) => r.id),
    [4n],
  );
  assert.equal(read.unchecked, 3n);
});

/** The distinct round ids a market was asked about, newest first. */
const askedIds = (chain) =>
  [...new Set(chain.calls.map((c) => idOf(c.data)))].sort((a, b) =>
    a < b ? 1 : -1,
  );

test("the look-back boundary: which ids are asked, how many are left unchecked, and never round 0", async () => {
  // Only latest = 8 separates a strict from a loose comparison with the look-back; 9 and 10 pin the offset.
  const cases = [
    { latest: 2n, ids: [1n], unchecked: 0n },
    { latest: 8n, ids: [7n, 6n, 5n, 4n, 3n, 2n, 1n], unchecked: 0n },
    { latest: 9n, ids: [8n, 7n, 6n, 5n, 4n, 3n, 2n, 1n], unchecked: 0n },
    { latest: 10n, ids: [9n, 8n, 7n, 6n, 5n, 4n, 3n, 2n], unchecked: 1n },
  ];
  for (const { latest, ids, unchecked } of cases) {
    const chain = marketOfRounds({});
    const read = await readEarlierRounds(chain, {
      market: MARKET,
      wallet: WALLET,
      latest,
      now: LATER,
    });
    assert.deepEqual(askedIds(chain), ids, `ids asked at latest ${latest}`);
    assert.equal(read.unchecked, unchecked, `unchecked at latest ${latest}`);
    assert.equal(chain.calls.length, 3 * ids.length);
    assert.ok(!chain.calls.some((c) => idOf(c.data) === 0n), "round 0 asked");
  }
});

test("an earlier block is read with a before bound: the next fixed block of ids below it, merged by the caller", async () => {
  const chain = marketOfRounds({ 20: { s: {} }, 12: { b: {} }, 11: { s: {} } });
  // The card's own window at latest 30 is 22..29; asking before 22 reads 14..21 and leaves 13 ids unchecked.
  const first = await readEarlierRounds(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 30n,
    before: 22n,
    now: LATER,
  });
  assert.deepEqual(askedIds(chain), [21n, 20n, 19n, 18n, 17n, 16n, 15n, 14n]);
  assert.deepEqual(
    first.rounds.map((r) => r.id),
    [20n],
  );
  assert.equal(first.unchecked, 13n);
  // The next block starts at the previous block's lowest id, so no id is skipped or read twice.
  const again = marketOfRounds({ 12: { b: {} }, 11: { s: {} } });
  const second = await readEarlierRounds(again, {
    market: MARKET,
    wallet: WALLET,
    latest: 30n,
    before: 14n,
    now: LATER,
  });
  assert.deepEqual(askedIds(again), [13n, 12n, 11n, 10n, 9n, 8n, 7n, 6n]);
  assert.deepEqual(
    second.rounds.map((r) => r.id),
    [12n, 11n],
  );
  assert.equal(second.unchecked, 5n);
  // The last block runs out at id 1 and never asks for round 0.
  const last = marketOfRounds({ 1: { s: {} } });
  const end = await readEarlierRounds(last, {
    market: MARKET,
    wallet: WALLET,
    latest: 30n,
    before: 6n,
    now: LATER,
  });
  assert.deepEqual(askedIds(last), [5n, 4n, 3n, 2n, 1n]);
  assert.deepEqual(
    end.rounds.map((r) => r.id),
    [1n],
  );
  assert.equal(end.unchecked, 0n);
});

test("a before bound that is not an id below or at the latest round is refused, and before 1 reads nothing", async () => {
  const chain = marketOfRounds({});
  await assert.rejects(
    readEarlierRounds(chain, {
      market: MARKET,
      wallet: WALLET,
      latest: 5n,
      before: 6n,
      now: LATER,
    }),
    /before/,
  );
  assert.deepEqual(
    await readEarlierRounds(chain, {
      market: MARKET,
      wallet: WALLET,
      latest: 5n,
      before: 1n,
      now: LATER,
    }),
    { rounds: [], unchecked: 0n },
  );
  assert.equal(chain.calls.length, 0);
  await assert.rejects(
    readEarlierRounds(chain, {
      market: MARKET,
      wallet: WALLET,
      latest: 5n,
      before: 0n,
      now: LATER,
    }),
    /before/,
  );
});

test("a market on its first round has no earlier ones to read", async () => {
  const chain = marketOfRounds({});
  assert.deepEqual(
    await readEarlierRounds(chain, {
      market: MARKET,
      wallet: WALLET,
      latest: 1n,
      now: LATER,
    }),
    { rounds: [], unchecked: 0n },
  );
  assert.equal(chain.calls.length, 0);
});

test("an earlier round that cannot be read fails the read, never a wallet owed nothing", async () => {
  const base = marketOfRounds({ 1: { s: {} } });
  const failing = {
    call: async (to, data) => {
      if (data.startsWith(sel("sells")) && idOf(data) === 1n) {
        throw new Error("rpc http 503");
      }
      return base.call(to, data);
    },
  };
  await assert.rejects(
    readEarlierRounds(failing, {
      market: MARKET,
      wallet: WALLET,
      latest: 3n,
      now: LATER,
    }),
    /rpc http 503/,
  );
  // A zeroed round below the count is not this market's answer.
  const zeroed = {
    call: async (to, data) =>
      data.startsWith(sel("rounds"))
        ? round({ opensAt: 0n })
        : base.call(to, data),
  };
  await assert.rejects(
    readEarlierRounds(zeroed, {
      market: MARKET,
      wallet: WALLET,
      latest: 3n,
      now: LATER,
    }),
    /no round/,
  );
});

/** `clearingOf`'s three words: level, matched lots, sellers share. */
const clearing = (level, matched, sellersShare = 0n) =>
  words(level, matched, sellersShare);

test("a settled round carries the lots that really traded, read from the market", async () => {
  // Offers and bids that never cross: asked and wanted stay the open totals, the market answers matched 0.
  const none = fakeChain({
    [sel("rounds")]: () => round({ settled: 1n, asked: 1n, wanted: 1n }),
    [sel("clearingOf")]: () => clearing(0n, 0n),
  });
  const a = await readSecondaryMarket(none, INPUT);
  assert.equal(a.round.phase, "settled");
  assert.equal(a.round.matched, 0n);
  // The round it asks about is the latest one, by id.
  const asked = none.calls.find((c) => c.data.startsWith(sel("clearingOf")));
  assert.equal(asked.to, MARKET);
  assert.equal(
    asked.data,
    encodeFunctionData(SECONDARY_SIGNATURES.clearingOf, ["uint256"], [7n]),
  );
  const some = fakeChain({
    [sel("rounds")]: () => round({ settled: 1n, price: 3n }),
    [sel("clearingOf")]: () => clearing(3n, 5n),
  });
  assert.equal((await readSecondaryMarket(some, INPUT)).round.matched, 5n);
  // A round still open is not asked: its clearing is a preview, not a result.
  const open = fakeChain();
  assert.equal((await readSecondaryMarket(open, INPUT)).round.matched, 0n);
  assert.ok(
    !open.calls.some((c) => c.data.startsWith(sel("clearingOf"))),
    "an open round is never asked for its clearing",
  );
});

test("a settled round whose clearing cannot be read is an unreadable market, never zero lots", async () => {
  const chain = fakeChain({
    [sel("rounds")]: () => round({ settled: 1n }),
    [sel("clearingOf")]: () => {
      throw new Error("rpc http 503");
    },
  });
  const read = await readSecondaryMarket(chain, INPUT);
  assert.equal(read.kind, "unreadable");
  assert.match(read.reason, /rpc http 503/);
});

test("an earlier settled round carries its matched lots too", async () => {
  const chain = marketOfRounds(
    { 1: { s: { lots: 1n } }, 2: { s: {} } },
    [1, 2],
    { 2: 2 },
  );
  const read = await readEarlierRounds(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 3n,
    now: LATER,
  });
  assert.deepEqual(
    read.rounds.map((r) => [r.id, r.round.matched]),
    [
      [2n, 2n],
      [1n, 0n],
    ],
  );
});

// ---- the unsold remainder a seller collects by claimShares -----------------------------------------------------

test("a part-filled seller in a settled round is owed its unsold lots, read through the production readers, until it collects them", async () => {
  // Round 3 is the latest (the market read), rounds 2 and 1 are earlier ones (the earlier read): one seller, four
  // shapes. `filled` is what settle wrote; `escrowReturned` is what claimShares wrote.
  const orders = {
    // Part-filled: 5 offered, 2 sold, 3 still in the market.
    3: { s: { lots: 5n, filled: 2n } },
    // The same offer after the seller collected the remainder.
    2: { s: { lots: 5n, filled: 2n, escrowReturned: 1n } },
    // Sold out whole: nothing was left to return, and the contract never sets the flag.
    1: { s: { lots: 5n, filled: 5n } },
  };
  const chain = marketOfRounds(orders, [1, 2, 3], { 1: 5, 2: 2, 3: 2 });
  const latest = await readSecondaryMarket(
    {
      call: (to, data) =>
        sel("roundCount") === data.slice(0, 10)
          ? Promise.resolve(words(3))
          : sel("marketOf") === data.slice(0, 10)
            ? Promise.resolve(words(BigInt(MARKET)))
            : sel("listing") === data.slice(0, 10)
              ? Promise.resolve(listing())
              : chain.call(to, data),
    },
    { ...INPUT, now: LATER },
  );
  assert.equal(latest.kind, "present");
  assert.equal(latest.round.phase, "settled");
  assert.equal(unsoldLots(latest.round, latest.wallet.sell), 3n);

  const earlier = await readEarlierRounds(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 3n,
    now: LATER,
  });
  const byId = Object.fromEntries(earlier.rounds.map((r) => [r.id, r]));
  assert.equal(byId[2n].sell.escrowReturned, true);
  assert.equal(unsoldLots(byId[2n].round, byId[2n].sell), 0n);
  assert.equal(unsoldLots(byId[1n].round, byId[1n].sell), 0n);
});

test("a void round owes the whole offer back until it is collected, and a round still open owes nothing", async () => {
  const chain = marketOfRounds({
    2: { s: { lots: 4n } },
    1: { s: { lots: 4n, escrowReturned: 1n } },
  });
  const read = await readEarlierRounds(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 3n,
    now: LATER,
  });
  const byId = Object.fromEntries(read.rounds.map((r) => [r.id, r]));
  assert.equal(byId[2n].round.phase, "void");
  assert.equal(unsoldLots(byId[2n].round, byId[2n].sell), 4n);
  assert.equal(unsoldLots(byId[1n].round, byId[1n].sell), 0n);
  // While bidding is open the offer is escrowed and cancelSell is the way out, not a claim.
  const open = await readSecondaryMarket(fakeChain(), INPUT);
  assert.equal(open.round.phase, "bidding");
  assert.equal(unsoldLots(open.round, open.wallet.sell), 0n);
  // No offer, no remainder.
  assert.equal(unsoldLots(open.round, null), 0n);
});
