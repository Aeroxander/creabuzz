import assert from "node:assert/strict";
import { test } from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import {
  HISTORY_PAGE,
  historyBlockBefore,
  historyQueryKey,
  mergeHistory,
  readHistoryBlock,
} from "./round-history.ts";
import {
  earlierPriceRow,
  earlierRoundsHeading,
  earlierShowsPrice,
  historyFailedLine,
  historyLoadingLine,
  roundOpenedLine,
  showOlderLabel,
} from "./trading-history-copy.ts";
import { money, roundLine } from "./trading-copy.ts";

const MARKET = `0x${"3a".repeat(20)}`;
const NOW = 100_000_000;
const WEEK = 7 * 86_400;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;
const sel = (signature) => selectorOf(signature);
const WAD = 10n ** 18n;

/**
 * A round as `rounds(uint256)` answers it: the grid 1 to 65 in steps of 1, opened `n` weeks after a fixed start.
 * `settled` rounds store the clearing level; an unsettled one past its deadline is void.
 */
function roundAnswer(n, { settled = false, level = 0, deadline } = {}) {
  const opensAt = 1_000_000 + n * WEEK;
  return words(
    WAD, // minPrice
    WAD, // step
    64, // levels
    opensAt,
    opensAt + 3 * 86_400, // closesAt
    deadline ?? opensAt + 5 * 86_400, // settleDeadline
    0, // asked
    0, // wanted
    level,
    settled ? 1 : 0,
    0,
  );
}

const idOf = (data) => BigInt(`0x${data.slice(10, 74)}`);

/** A chain scripted per round id; `calls` lists what was asked. */
function historyChain({ rounds, clearing = {}, now = NOW, fail = {} }) {
  const calls = [];
  return {
    calls,
    now: async () => now,
    call: async (to, data) => {
      assert.equal(to, MARKET);
      const selector = data.slice(0, 10);
      const id = idOf(data);
      calls.push({ selector, id });
      if (fail[`${selector}:${id}`]) throw new Error("node unreachable");
      if (selector === sel("rounds(uint256)")) {
        const answer = rounds[id.toString()];
        if (answer === undefined) throw new Error(`unscripted round ${id}`);
        return answer;
      }
      if (selector === sel("clearingOf(uint256)")) {
        const answer = clearing[id.toString()];
        if (answer === undefined) throw new Error(`unscripted clearing ${id}`);
        return answer;
      }
      throw new Error(`unscripted call ${selector}`);
    },
  };
}

const clearingAnswer = (level, matched) => words(level, matched, 0);

// ---- the bound ----------------------------------------------------------------------------------

test("the blocks of earlier rounds are a fixed size and walk down to round 1, never to round 0", () => {
  assert.equal(HISTORY_PAGE, 12);
  assert.equal(historyBlockBefore(30n, 0), 30n);
  assert.equal(historyBlockBefore(30n, 1), 18n);
  assert.equal(historyBlockBefore(30n, 2), 6n);
  assert.equal(historyBlockBefore(30n, 3), null);
  // Round 1 is the only round: there is no earlier one to list.
  assert.equal(historyBlockBefore(1n, 0), null);
  assert.equal(historyBlockBefore(0n, 0), null);
  assert.equal(historyBlockBefore(2n, 0), 2n);
  assert.equal(historyBlockBefore(2n, 1), null);
  assert.equal(historyBlockBefore(30n, -1), null);
});

test("one block reads at most one page of rounds, newest first, and says how many older ones are left", async () => {
  const rounds = {};
  const clearing = {};
  for (let id = 1; id <= 39; id++) {
    rounds[id] = roundAnswer(id, { settled: true, level: id });
    clearing[id] = clearingAnswer(id, BigInt(id));
  }
  const chain = historyChain({ rounds, clearing });
  const block = await readHistoryBlock(chain, { market: MARKET, before: 40n });
  assert.deepEqual(
    block.rounds.map((r) => r.id),
    [39n, 38n, 37n, 36n, 35n, 34n, 33n, 32n, 31n, 30n, 29n, 28n],
  );
  assert.equal(block.older, 27n);
  // Two calls a round at most: a fixed number of reads, whatever the history holds.
  assert.equal(chain.calls.length, 24);
  assert.ok(chain.calls.every((c) => c.id >= 28n && c.id <= 39n));
  // The last block is short and has nothing older.
  const last = await readHistoryBlock(chain, { market: MARKET, before: 5n });
  assert.deepEqual(
    last.rounds.map((r) => r.id),
    [4n, 3n, 2n, 1n],
  );
  assert.equal(last.older, 0n);
});

// ---- what each round says -------------------------------------------------------------------------

test("a settled round that matched lots has its price and lots; a void or crossing-less one has neither", async () => {
  const chain = historyChain({
    rounds: {
      1: roundAnswer(1, { settled: true, level: 4 }),
      2: roundAnswer(2), // nobody settled it, long past its deadline
      3: roundAnswer(3, { settled: true, level: 0 }), // settled, nothing crossed
      4: roundAnswer(4, { settled: true, level: 9 }),
    },
    clearing: {
      1: clearingAnswer(4, 2n),
      3: clearingAnswer(0, 0n),
      4: clearingAnswer(9, 1n),
    },
  });
  const { rounds } = await readHistoryBlock(chain, {
    market: MARKET,
    before: 5n,
  });
  assert.deepEqual(
    rounds.map((r) => [r.id, r.outcome]),
    [
      [4n, { kind: "traded", lots: 1n, price: 10n * WAD }],
      [3n, { kind: "none" }],
      [2n, { kind: "none" }],
      [1n, { kind: "traded", lots: 2n, price: 5n * WAD }],
    ],
  );
  // When the round opened, as the contract recorded it.
  assert.equal(rounds[3].opensAt, 1_000_000 + WEEK);
  // A void round was never asked for a clearing: nothing traded in it, and a preview would be a guess.
  assert.ok(
    !chain.calls.some(
      (c) => c.selector === sel("clearingOf(uint256)") && c.id === 2n,
    ),
  );
});

// ---- Review-Proven Rule 1: a failed read is never an empty list ----------------------------------------

test("a call that failed makes the whole block fail, never an empty or shorter list", async () => {
  const rounds = {
    1: roundAnswer(1, { settled: true, level: 1 }),
    2: roundAnswer(2, { settled: true, level: 1 }),
  };
  const clearing = { 1: clearingAnswer(1, 1n), 2: clearingAnswer(1, 1n) };
  for (const fail of [
    { [`${sel("rounds(uint256)")}:1`]: true },
    { [`${sel("clearingOf(uint256)")}:2`]: true },
  ]) {
    await assert.rejects(
      readHistoryBlock(historyChain({ rounds, clearing, fail }), {
        market: MARKET,
        before: 3n,
      }),
      /node unreachable/,
    );
  }
});

test("an answer that is not a round of this market, or a round still open below the latest, is an error", async () => {
  const empty = words(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  await assert.rejects(
    readHistoryBlock(historyChain({ rounds: { 1: empty } }), {
      market: MARKET,
      before: 2n,
    }),
    /no round 1/,
  );
  // Round 1 is still taking bids at the chain's clock: it cannot be an earlier round, so it is not guessed at.
  await assert.rejects(
    readHistoryBlock(
      historyChain({
        rounds: { 1: roundAnswer(1) },
        now: 1_000_000 + WEEK + 60,
      }),
      { market: MARKET, before: 2n },
    ),
    /not finished/,
  );
  await assert.rejects(
    readHistoryBlock(historyChain({ rounds: {} }), {
      market: "0x12",
      before: 2n,
    }),
    /not an address/,
  );
  await assert.rejects(
    readHistoryBlock(historyChain({ rounds: {} }), {
      market: MARKET,
      before: 0n,
    }),
    /before round/,
  );
});

test("blocks are merged in order and stop at the first one that has not arrived", () => {
  const block = (ids, older) => ({
    data: {
      rounds: ids.map((id) => ({ id, opensAt: 1, outcome: { kind: "none" } })),
      older,
    },
  });
  const merged = mergeHistory([block([5n, 4n], 3n), block([3n, 2n], 1n)]);
  assert.deepEqual(
    merged.rounds.map((r) => r.id),
    [5n, 4n, 3n, 2n],
  );
  assert.equal(merged.older, 1n);
  assert.equal(merged.loaded, 2);
  // A block still reading or failed leaves a gap: the ones after it are not shown and the ids are not claimed checked.
  const gap = mergeHistory([block([5n, 4n], 3n), {}, block([1n], 0n)]);
  assert.deepEqual(
    gap.rounds.map((r) => r.id),
    [5n, 4n],
  );
  assert.equal(gap.older, 3n);
  assert.equal(gap.loaded, 1);
  // Nothing arrived yet: no claim about what is older.
  assert.deepEqual(mergeHistory([{}]), { rounds: [], older: null, loaded: 0 });
});

// ---- the key fences a read to its market and block --------------------------------------------------

test("a block's key names its market and its own bound, so another market's or another week's read is never taken for it", () => {
  const key = historyQueryKey(MARKET.toUpperCase().replace("0X", "0x"), 30n);
  assert.deepEqual(key, historyQueryKey(MARKET, 30n));
  assert.notDeepEqual(key, historyQueryKey(MARKET, 18n));
  assert.notDeepEqual(key, historyQueryKey(`0x${"4b".repeat(20)}`, 30n));
});

// ---- the words ------------------------------------------------------------------------------------

const USDC = { quoteDecimals: 6, quoteSymbol: "USDC" };
const FQ = { quoteDecimals: 18, quoteSymbol: "FQ" };

test("a row names the day with its time zone, and a price in the same words as the latest round's line", () => {
  const traded = {
    id: 4n,
    opensAt: 1_793_617_200, // Nov 2, 2026, 11:00 UTC
    outcome: { kind: "traded", lots: 3n, price: 1_250_000n },
  };
  const row = earlierPriceRow(traded, USDC, "UTC");
  assert.equal(row.when, "Opened Nov 2, 2026, 11:00 AM UTC");
  assert.equal(row.outcome, "3 lots traded at 1.25 USDC a lot");
  // Another zone says its own name for it.
  assert.match(
    earlierPriceRow(traded, USDC, "America/New_York").when,
    /Nov 2, 2026, 6:00 AM EST$/,
  );
  // The price is the latest round's money(): the same units and decimals, so the two lines can be read side by side.
  const latest = roundLine(
    {
      phase: "settled",
      closesAt: 1,
      settleDeadline: 2,
      matched: 3n,
      price: 0,
      minPrice: 1_250_000n,
      step: 1n,
    },
    USDC,
  );
  assert.ok(latest.includes(`${money(1_250_000n, USDC)} a lot`));
  assert.ok(row.outcome.includes(`${money(1_250_000n, USDC)} a lot`));
  // An 18-decimal token keeps its own scale, and one lot reads as one.
  assert.equal(
    earlierPriceRow(
      { ...traded, outcome: { kind: "traded", lots: 1n, price: 5n * WAD } },
      FQ,
      "UTC",
    ).outcome,
    "1 lot traded at 5 FQ a lot",
  );
});

test("a round with no trade says so and prints no price", () => {
  const row = earlierPriceRow(
    { id: 2n, opensAt: 1_793_617_200, outcome: { kind: "none" } },
    USDC,
    "UTC",
  );
  assert.equal(row.outcome, "No trade");
  assert.doesNotMatch(row.outcome, /USDC|\d/);
});

test("the label is wanted exactly when the list prints a price", () => {
  const none = { id: 2n, opensAt: 1, outcome: { kind: "none" } };
  const traded = {
    id: 1n,
    opensAt: 1,
    outcome: { kind: "traded", lots: 1n, price: 1n },
  };
  assert.equal(earlierShowsPrice([]), false);
  assert.equal(earlierShowsPrice([none, none]), false);
  assert.equal(earlierShowsPrice([none, traded]), true);
});

test("the list's own words are plain, and a failed read is said as such", () => {
  assert.equal(earlierRoundsHeading(), "Earlier rounds");
  assert.equal(
    historyFailedLine(),
    "Could not load earlier rounds. Try again.",
  );
  assert.equal(historyLoadingLine(), "Loading earlier rounds…");
  assert.equal(showOlderLabel(false), "Show older rounds");
  assert.equal(showOlderLabel(true), "Loading…");
  assert.equal(
    roundOpenedLine(1_793_617_200, "UTC"),
    "Opened Nov 2, 2026, 11:00 AM UTC",
  );
});
