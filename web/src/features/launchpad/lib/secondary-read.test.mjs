import assert from "node:assert/strict";
import { test } from "node:test";

import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import { listingFormDraft } from "./listing-draft.ts";
import { LIVE_REFRESH_MS, SLOW_REFRESH_MS } from "./trading-copy.ts";
import {
  olderBlockBefore,
  mergeOlderRounds,
  pollSecondary,
  readMarketForWords,
  readOlderBlock,
  readSecondaryView,
  readWalletFunds,
} from "./secondary-read.ts";

const FACTORY = `0x${"fa".repeat(20)}`;
const MARKET = `0x${"3a".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const WALLET = `0x${"be".repeat(20)}`;
const SHARES = `0x${"51".repeat(20)}`;
const QUOTE = `0x${"c0".repeat(20)}`;
const POLICY = `0x${"90".repeat(20)}`;
const ZERO = `0x${"00".repeat(20)}`;
const NOW = 1_100_000;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;
const sel = (signature) => selectorOf(signature);

/** An ABI `string` answer, as a standard token's `symbol()` gives it. */
const stringAnswer = (text) => {
  const bytes = Buffer.from(text, "utf8");
  const padded = bytes
    .toString("hex")
    .padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `${words(32, bytes.length)}${padded}`;
};

const listing = (enabled = 1n) => words(enabled, 1_000_000n, 1_064_000n, 8n);
const round = () =>
  words(
    1_000_000n,
    8_000n,
    8n,
    1_000_000n,
    1_259_200n,
    1_432_000n,
    12n,
    9n,
    0n,
    0n,
    0n,
  );
const sell = (lots = 0n) => words(lots, 2n, 0n, 11n, 0n, 0n);
const bid = () => words(0n, 0n, 0n, 0n, 0n, 0n, 0n);

/**
 * A chain that answers each call by `to:selector` (or by selector alone). A value replaces the answer; a function
 * throwing stands for a node that failed. `calls` records what was asked.
 */
function fakeChain(over = {}) {
  const answers = {
    [`${FACTORY}:${sel("marketOf(address)")}`]: () => words(BigInt(MARKET)),
    [`${MARKET}:${sel("listing()")}`]: () => listing(),
    [`${MARKET}:${sel("roundCount()")}`]: () => words(2),
    [`${MARKET}:${sel("rounds(uint256)")}`]: () => round(),
    [`${MARKET}:${sel("sells(uint256,address)")}`]: () => sell(),
    [`${MARKET}:${sel("bids(uint256,address)")}`]: () => bid(),
    [`${MARKET}:${sel("lotSize()")}`]: () => words(40n * 10n ** 18n),
    [`${MARKET}:${sel("sharesToken()")}`]: () => words(BigInt(SHARES)),
    [`${MARKET}:${sel("quote()")}`]: () => words(BigInt(QUOTE)),
    [`${MARKET}:${sel("policy()")}`]: () => words(BigInt(POLICY)),
    [`${QUOTE}:${sel("decimals()")}`]: () => words(6),
    [`${QUOTE}:${sel("symbol()")}`]: () => stringAnswer("USDC"),
    [`${POLICY}:${sel("saleCapacity(address)")}`]: () => words(5n * 10n ** 18n),
    [`${SHARES}:${sel("balanceOf(address)")}`]: () => words(9n * 10n ** 18n),
    [`${QUOTE}:${sel("balanceOf(address)")}`]: () => words(12_000_000n),
    [`${QUOTE}:${sel("allowance(address,address)")}`]: () => words(0),
    ...over,
  };
  const calls = [];
  return {
    calls,
    now: async () => NOW,
    call: async (to, data) => {
      calls.push({ to, selector: data.slice(0, 10) });
      const answer = answers[`${to}:${data.slice(0, 10)}`];
      if (!answer)
        throw new Error(`unscripted call ${to} ${data.slice(0, 10)}`);
      const value = typeof answer === "function" ? answer(data) : answer;
      return value;
    },
  };
}

const key = (to, signature) => `${to}:${sel(signature)}`;
const boom = () => {
  throw new Error("node unreachable");
};
const INPUT = { factory: FACTORY, dao: DAO, wallet: WALLET };

// ---- Review-Proven Rule 1: the readers never turn "no answer" into zero ----------------------------

const WALLET_INPUT = {
  market: MARKET,
  wallet: WALLET,
  sharesToken: SHARES,
  quoteToken: QUOTE,
  policyHex: words(BigInt(POLICY)),
};
const GARBAGE = [
  ["an empty answer", "0x"],
  ["a short answer", "0x1234"],
  ["a word and a half", `0x${"00".repeat(48)}`],
  ["two words", words(1, 2)],
  ["not hex", `0x${"zz".repeat(32)}`],
  ["no answer at all", undefined],
];
const FUNDS_CALLS = [
  ["saleCapacity", POLICY, "saleCapacity(address)"],
  ["the Shares balance", SHARES, "balanceOf(address)"],
  ["the quote balance", QUOTE, "balanceOf(address)"],
  ["the allowance", QUOTE, "allowance(address,address)"],
];

test("a wallet's funds are read as the four numbers the chain answered", async () => {
  const funds = await readWalletFunds(fakeChain(), WALLET_INPUT);
  assert.deepEqual(funds, {
    saleCapacity: 5n * 10n ** 18n,
    shares: 9n * 10n ** 18n,
    quote: 12_000_000n,
    quoteAllowance: 0n,
  });
});

for (const [what, to, signature] of FUNDS_CALLS) {
  for (const [kind, answer] of GARBAGE) {
    test(`${what} answering ${kind} fails the whole read: never a wallet holding zero`, async () => {
      const chain = fakeChain({ [key(to, signature)]: () => answer });
      await assert.rejects(
        () => readWalletFunds(chain, WALLET_INPUT),
        /did not answer a number/,
      );
    });
  }
  test(`${what} that fails to answer propagates`, async () => {
    const chain = fakeChain({ [key(to, signature)]: boom });
    await assert.rejects(
      () => readWalletFunds(chain, WALLET_INPUT),
      /node unreachable/,
    );
  });
}

test("a zero-address sale policy is a read we do not have, not a wallet that may offer nothing", async () => {
  await assert.rejects(
    () =>
      readWalletFunds(fakeChain(), {
        ...WALLET_INPUT,
        policyHex: words(BigInt(ZERO)),
      }),
    /did not report its sale policy/,
  );
});

test("a real zero answer is still zero", async () => {
  const chain = fakeChain({
    [key(QUOTE, "balanceOf(address)")]: () => words(0),
  });
  assert.equal((await readWalletFunds(chain, WALLET_INPUT)).quote, 0n);
});

test("the market for a vote's words: none only when the factory says the zero address", async () => {
  const none = fakeChain({
    [key(FACTORY, "marketOf(address)")]: () => words(0),
  });
  assert.equal(
    await readMarketForWords(none, { factory: FACTORY, dao: DAO }),
    null,
  );
  const found = await readMarketForWords(fakeChain(), {
    factory: FACTORY,
    dao: DAO,
  });
  assert.deepEqual(found, {
    address: MARKET,
    quoteDecimals: 6,
    quoteSymbol: "USDC",
  });
});

for (const [kind, answer] of GARBAGE) {
  test(`the factory answering ${kind} is not "this DAO has no market"`, async () => {
    const chain = fakeChain({
      [key(FACTORY, "marketOf(address)")]: () => answer,
    });
    await assert.rejects(
      () => readMarketForWords(chain, { factory: FACTORY, dao: DAO }),
      /did not answer an address/,
    );
  });
}

test("a factory answer wider than an address, a failed call and a zero price token all throw", async () => {
  const wide = fakeChain({
    [key(FACTORY, "marketOf(address)")]: () => words(1n << 160n),
  });
  await assert.rejects(
    () => readMarketForWords(wide, { factory: FACTORY, dao: DAO }),
    /address/,
  );
  const down = fakeChain({ [key(FACTORY, "marketOf(address)")]: boom });
  await assert.rejects(
    () => readMarketForWords(down, { factory: FACTORY, dao: DAO }),
    /unreachable/,
  );
  const noQuote = fakeChain({ [key(MARKET, "quote()")]: () => words(0) });
  await assert.rejects(
    () => readMarketForWords(noQuote, { factory: FACTORY, dao: DAO }),
    /price token/,
  );
});

test("a price token that will not say its units leaves a vote's prices in base units", async () => {
  const chain = fakeChain({ [key(QUOTE, "decimals()")]: boom });
  assert.deepEqual(
    await readMarketForWords(chain, { factory: FACTORY, dao: DAO }),
    {
      address: MARKET,
      quoteDecimals: undefined,
      quoteSymbol: undefined,
    },
  );
});

// ---- the card's read ------------------------------------------------------------------------------

test("a complete read gives the market, its facts, the round id and the wallet's funds", async () => {
  const view = await readSecondaryView(fakeChain(), INPUT);
  assert.equal(view.read.kind, "present");
  assert.equal(view.market, MARKET);
  assert.equal(view.roundId, 2n);
  assert.equal(view.facts.quoteDecimals, 6);
  assert.equal(view.facts.quoteSymbol, "USDC");
  assert.equal(view.tokenUnreadable, false);
  assert.equal(view.funds.quote, 12_000_000n);
});

test("a read that did not complete throws, so the query keeps and retries instead of resolving a failure", async () => {
  const chain = fakeChain({ [key(MARKET, "listing()")]: boom });
  await assert.rejects(
    () => readSecondaryView(chain, INPUT),
    /node unreachable/,
  );
  const garbage = fakeChain({
    [key(FACTORY, "marketOf(address)")]: () => "0x12",
  });
  await assert.rejects(() => readSecondaryView(garbage, INPUT));
});

test("a DAO the factory knows no market for is a genuine absence, not a failure", async () => {
  const chain = fakeChain({
    [key(FACTORY, "marketOf(address)")]: () => words(0),
  });
  const view = await readSecondaryView(chain, INPUT);
  assert.equal(view.read.kind, "absent");
  assert.equal(view.market, null);
});

test("a failing second read leaves the first answer in the query, and a recovered one replaces it", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  let chain = fakeChain();
  const observer = new QueryObserver(client, {
    queryKey: ["launchpad", "secondary", DAO],
    queryFn: () => readSecondaryView(chain, INPUT),
  });
  try {
    await observer.refetch();
    const first = observer.getCurrentResult();
    assert.equal(first.isError, false);
    assert.equal(first.data.read.kind, "present");

    chain = fakeChain({ [key(MARKET, "listing()")]: boom });
    await observer.refetch();
    const failed = observer.getCurrentResult();
    // The query errored (so it retries and the card can say it could not refresh) yet still holds the last good view.
    assert.equal(failed.isError, true);
    assert.equal(failed.data, first.data);
    assert.equal(failed.data.read.kind, "present");

    chain = fakeChain();
    await observer.refetch();
    const recovered = observer.getCurrentResult();
    assert.equal(recovered.isError, false);
    assert.equal(recovered.data.roundId, 2n);
  } finally {
    client.clear();
  }
});

test("polling goes on after a failed read, slower each time, and returns to the live pace on success", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  let chain = fakeChain();
  const options = {
    queryKey: ["launchpad", "secondary", DAO, WALLET],
    queryFn: () => readSecondaryView(chain, INPUT),
  };
  const observer = new QueryObserver(client, options);
  const calm = new Map();
  const poll = () =>
    pollSecondary(
      client.getQueryCache().find({ queryKey: options.queryKey }),
      calm,
    );
  try {
    await observer.refetch();
    // A live round: the usual pace.
    assert.equal(poll(), LIVE_REFRESH_MS);
    chain = fakeChain({ [key(MARKET, "listing()")]: boom });
    await observer.refetch();
    assert.equal(poll(), 2 * LIVE_REFRESH_MS);
    await observer.refetch();
    assert.equal(poll(), 4 * LIVE_REFRESH_MS);
    for (let i = 0; i < 6; i++) await observer.refetch();
    // Capped, and still polling: never false, never faster than the live pace.
    assert.equal(poll(), SLOW_REFRESH_MS);
    chain = fakeChain();
    await observer.refetch();
    assert.equal(poll(), LIVE_REFRESH_MS);
    // A first failure after that starts the backoff over.
    chain = fakeChain({ [key(MARKET, "listing()")]: boom });
    await observer.refetch();
    assert.equal(poll(), 2 * LIVE_REFRESH_MS);
  } finally {
    client.clear();
  }
});

test("a card that never read anything still tries again after a failure", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  const chain = fakeChain({ [key(MARKET, "listing()")]: boom });
  const options = {
    queryKey: ["launchpad", "secondary", DAO, "first"],
    queryFn: () => readSecondaryView(chain, INPUT),
  };
  const observer = new QueryObserver(client, options);
  try {
    await observer.refetch();
    const found = client.getQueryCache().find({ queryKey: options.queryKey });
    assert.equal(found.state.data, undefined);
    assert.equal(pollSecondary(found, new Map()), 2 * LIVE_REFRESH_MS);
  } finally {
    client.clear();
  }
});

// ---- a price token that will not name itself must not hide a claim ---------------------------------

const BLIND_TOKENS = [
  [
    "a token whose symbol is not printable ASCII",
    { [key(QUOTE, "symbol()")]: () => stringAnswer("Dollarü") },
  ],
  [
    "a token whose symbol is longer than 32 characters",
    { [key(QUOTE, "symbol()")]: () => stringAnswer("X".repeat(40)) },
  ],
  ["a token that refuses decimals()", { [key(QUOTE, "decimals()")]: boom }],
];

for (const [what, over] of BLIND_TOKENS) {
  test(`${what} keeps the round, the id and what earlier rounds owe, so Collect stays`, async () => {
    const chain = fakeChain({
      ...over,
      // The wallet has an offer in the earlier round 1.
      [key(MARKET, "sells(uint256,address)")]: () => sell(3n),
    });
    const view = await readSecondaryView(chain, INPUT);
    assert.equal(view.read.kind, "present");
    assert.equal(view.tokenUnreadable, true);
    assert.equal(view.market, MARKET);
    assert.ok(view.facts, "the lot size and tokens are still known");
    assert.equal(view.facts.lotSize, 40n * 10n ** 18n);
    assert.equal(view.facts.quoteKnown, false);
    assert.equal(view.roundId, 2n);
    assert.equal(view.read.wallet.sell.lots, 3n);
    assert.equal(view.earlier.rounds.length, 1);
    assert.equal(view.earlier.rounds[0].id, 1n);
  });
}

test("a readable token is marked known", async () => {
  const view = await readSecondaryView(fakeChain(), INPUT);
  assert.equal(view.facts.quoteKnown, true);
});

test("with the price token blind no order form is fed: the wallet's funds are not read", async () => {
  const chain = fakeChain({ [key(QUOTE, "decimals()")]: boom });
  const view = await readSecondaryView(chain, INPUT);
  assert.equal(view.funds, null);
});

// ---- the off switch needs only the market ----------------------------------------------------------

const WALLET_CALLS = [
  [POLICY, "saleCapacity(address)"],
  [SHARES, "balanceOf(address)"],
  [QUOTE, "balanceOf(address)"],
  [QUOTE, "allowance(address,address)"],
  [MARKET, "sells(uint256,address)"],
  [MARKET, "bids(uint256,address)"],
];
const walletsFail = () =>
  Object.fromEntries(WALLET_CALLS.map(([to, sig]) => [key(to, sig), boom]));

const form = (view, over = {}) => ({
  factoryKnown: true,
  failed: false,
  read: view?.read ?? null,
  market: view?.market ?? null,
  quote: view?.facts?.quoteKnown
    ? { decimals: view.facts.quoteDecimals, symbol: view.facts.quoteSymbol }
    : null,
  lotSize: view?.facts?.lotSize ?? null,
  enabled: "off",
  minText: "",
  maxText: "",
  levelsText: "",
  ...over,
});

test("the listing form reads the market without a wallet, so a wallet read failing cannot take the off switch", async () => {
  // The form asks with no wallet: none of the wallet's reads are made, and the market is read in full.
  const chain = fakeChain(walletsFail());
  const view = await readSecondaryView(chain, { ...INPUT, wallet: null });
  assert.equal(view.market, MARKET);
  assert.equal(view.funds, null);
  const walletCalls = chain.calls.filter((c) =>
    [
      sel("balanceOf(address)"),
      sel("allowance(address,address)"),
      sel("saleCapacity(address)"),
    ].includes(c.selector),
  );
  assert.deepEqual(walletCalls, []);
  const result = listingFormDraft(form(view));
  assert.ok("draft" in result, JSON.stringify(result));
  assert.equal(result.draft.to, MARKET);
});

test("the same failing wallet read does fail a read made with the wallet (so the form must not ask with one)", async () => {
  await assert.rejects(
    () => readSecondaryView(fakeChain(walletsFail()), INPUT),
    /node unreachable/,
  );
});

test("the off switch survives a price token that stopped answering", async () => {
  const chain = fakeChain({ [key(QUOTE, "decimals()")]: boom });
  const view = await readSecondaryView(chain, { ...INPUT, wallet: null });
  assert.equal(view.market, MARKET);
  const off = listingFormDraft(form(view));
  assert.ok("draft" in off, JSON.stringify(off));
  const on = listingFormDraft(
    form(view, { enabled: "on", minText: "1", maxText: "2", levelsText: "4" }),
  );
  assert.ok("problem" in on, "prices still need the token's scale");
});

// ---- older rounds: the next fixed block, one click at a time -----------------------------------------------------

test("older blocks start at the lowest id already checked and step down by the look-back until round 1", () => {
  // 20 ids are unchecked (1..20): blocks start below 21, 13, 5, and then there is nothing left.
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => olderBlockBefore(20n, i)),
    [21n, 13n, 5n, null],
  );
  // Exactly one block's worth, and none.
  assert.deepEqual(
    [olderBlockBefore(8n, 0), olderBlockBefore(8n, 1)],
    [9n, null],
  );
  assert.equal(olderBlockBefore(0n, 0), null);
  // A fixed block is never round 0: the last block's `before` is always above 1.
  for (let unchecked = 1n; unchecked < 40n; unchecked++) {
    for (let i = 0; olderBlockBefore(unchecked, i) !== null; i++) {
      assert.ok(olderBlockBefore(unchecked, i) > 1n);
    }
  }
});

test("an older block is read at the chain's own time, asking only the ids below its bound", async () => {
  const asked = [];
  const chain = {
    now: async () => NOW,
    call: async (_to, data) => {
      asked.push(data.slice(0, 10));
      if (data.startsWith(sel("rounds(uint256)"))) return round();
      if (data.startsWith(sel("sells(uint256,address)")))
        return words(1, 0, 0, 0, 0, 0);
      if (data.startsWith(sel("bids(uint256,address)")))
        return words(0, 0, 0, 0, 0, 0, 0);
      return words(0, 0, 0);
    },
  };
  const read = await readOlderBlock(chain, {
    market: MARKET,
    wallet: WALLET,
    latest: 30n,
    before: 3n,
  });
  assert.equal(read.unchecked, 0n);
  assert.ok(asked.length >= 6, "ids 2 and 1 were asked about");
  await assert.rejects(
    readOlderBlock(
      {
        now: async () => NOW,
        call: async () => {
          throw new Error("rpc 503");
        },
      },
      { market: MARKET, wallet: WALLET, latest: 30n, before: 3n },
    ),
    /rpc 503/,
  );
});

test("older blocks merge newest first and count as checked only up to the first block that has not arrived", () => {
  const row = (id) => ({ id, round: {}, sell: null, bid: null });
  const block = (ids, unchecked) => ({
    data: { rounds: ids.map(row), unchecked },
  });
  const ok = mergeOlderRounds(20n, [block([12n, 9n], 12n), block([4n], 4n)]);
  assert.deepEqual(
    ok.rounds.map((r) => r.id),
    [12n, 9n, 4n],
  );
  assert.equal(ok.unchecked, 4n);
  // A failed or pending first block leaves everything unchecked, even if a later block arrived.
  const gap = mergeOlderRounds(20n, [{ data: undefined }, block([4n], 4n)]);
  assert.deepEqual(gap.rounds, []);
  assert.equal(gap.unchecked, 20n);
  // The second block failing keeps the first's rows and counts only the first as checked.
  const half = mergeOlderRounds(20n, [block([12n], 12n), { data: undefined }]);
  assert.deepEqual(
    half.rounds.map((r) => r.id),
    [12n],
  );
  assert.equal(half.unchecked, 12n);
  // Nothing asked yet.
  assert.deepEqual(mergeOlderRounds(20n, []), { rounds: [], unchecked: 20n });
  // Past the end it never goes below zero.
  assert.equal(mergeOlderRounds(3n, [block([], 0n)]).unchecked, 0n);
});
