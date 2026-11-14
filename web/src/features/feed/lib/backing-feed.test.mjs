import assert from "node:assert/strict";
import test from "node:test";

import { backingFeedItems, backingFeedLine } from "./backing-feed.ts";

const quote = { address: "0x", decimals: 6, symbol: "tTEST" };
const ONE = 10n ** 6n;
const A = `0x${"aa".repeat(20)}`;
const B = `0x${"bb".repeat(20)}`;
const DAY = 86_400;
const NOON = 1_700_000_000 - (1_700_000_000 % DAY) + 43_200; // noon UTC of some day

let seq = 0;
const bought = (block, buyer, quoteIn, priceAfter) => ({
  kind: "bought",
  block,
  logIndex: seq++ % 100,
  tx: "",
  buyer,
  quoteIn,
  unitsOut: 1n,
  fee: 1n,
  toEscrow: 1n,
  priceAfter,
});
const sold = (block, priceAfter) => ({
  kind: "sold",
  block,
  logIndex: 0,
  tx: "",
  seller: A,
  unitsIn: 1n,
  quoteOut: 1n,
  fee: 1n,
  refund: 0n,
  priceAfter,
});
const left = (block, id) => ({
  kind: "left",
  block,
  logIndex: 1,
  tx: "",
  id,
  backer: A,
  unitsIn: 1n,
  quoteOut: 1n,
  fromEscrow: 1n,
  priceAfter: 1n,
});
const posted = (block, id, windowEndsAt) => ({
  kind: "milestone-posted",
  block,
  logIndex: 0,
  tx: "",
  id,
  ref: `0x${"12".repeat(32)}`,
  by: A,
  windowEndsAt,
  resolveBy: windowEndsAt + 7 * DAY,
  tranche: 5n,
});
const resolved = (block, id, released, amount) => ({
  kind: "milestone-resolved",
  block,
  logIndex: 0,
  tx: "",
  id,
  released,
  amount,
});

const pool = (events, times) => ({
  coordinate: "37001:aa:docs",
  pool: "0xpool",
  quote,
  // The events come newest first, as the read gives them.
  events: [...events].sort((a, b) => b.block - a.block),
  times: new Map(Object.entries(times).map(([b, t]) => [Number(b), t])),
});

test("a day's buys are one line: how many backers, what was paid in, and how the price moved from the trade before", () => {
  const items = backingFeedItems(
    [
      pool(
        [
          sold(5, 1000n),
          bought(10, A, 100n * ONE, 1050n),
          bought(11, B, 50n * ONE, 1100n),
          bought(12, A, 25n * ONE, 1120n),
        ],
        { 5: NOON - 3 * DAY, 10: NOON, 11: NOON + 60, 12: NOON + 120 },
      ),
    ],
    NOON + 3_600,
  );
  assert.equal(items.length, 1);
  const [item] = items;
  assert.deepEqual(item.card, {
    kind: "backed",
    backers: 2,
    paidIn: 175n * ONE,
    moved: 12,
  });
  assert.equal(item.at, NOON + 120);
  assert.equal(
    backingFeedLine(item, "Docs Commons"),
    "Backed Docs Commons: 2 backers · 175 tTEST paid in · price moved up 12%",
  );
});

test("buys on two days are two lines, and with no earlier trade there is no move to claim", () => {
  const items = backingFeedItems(
    [
      pool([bought(10, A, ONE, 1000n), bought(20, B, 2n * ONE, 1100n)], {
        10: NOON - DAY,
        20: NOON,
      }),
    ],
    NOON + 10,
  );
  assert.equal(items.length, 2);
  assert.deepEqual(items[1].card, {
    kind: "backed",
    backers: 1,
    paidIn: ONE,
    moved: null,
  });
  // The second day moved from the first day's last trade.
  assert.equal(items[0].card.moved, 10);
  assert.equal(
    backingFeedLine(items[1], "P"),
    "Backed P: 1 backer · 1 tTEST paid in",
  );
});

test("a price that did not move is said as held, and one that fell as down", () => {
  const held = backingFeedItems(
    [
      pool([sold(5, 1000n), bought(10, A, ONE, 1000n)], {
        5: NOON - DAY,
        10: NOON,
      }),
    ],
    NOON + 10,
  );
  assert.match(backingFeedLine(held[0], "P"), /price held$/);
  const down = backingFeedItems(
    [
      pool([sold(5, 1000n), bought(10, A, ONE, 900n)], {
        5: NOON - DAY,
        10: NOON,
      }),
    ],
    NOON + 10,
  );
  assert.match(backingFeedLine(down[0], "P"), /price moved down 10%$/);
});

test("milestones: posted, released after some left, released with nothing, and not settled", () => {
  const items = backingFeedItems(
    [
      pool(
        [
          posted(30, 1n, NOON + 5 * DAY),
          left(31, 1n),
          left(31, 1n),
          resolved(40, 1n, true, 30n * ONE),
          posted(50, 2n, NOON + 40 * DAY),
          resolved(60, 2n, true, 0n),
          posted(70, 3n, NOON + 80 * DAY),
          resolved(80, 3n, false, 0n),
        ],
        {
          30: NOON,
          31: NOON + 10,
          40: NOON + 6 * DAY,
          50: NOON + 30 * DAY,
          60: NOON + 37 * DAY,
          70: NOON + 70 * DAY,
          80: NOON + 90 * DAY,
        },
      ),
    ],
    NOON + 100 * DAY,
  );
  const lines = items.map((i) => backingFeedLine(i, "P"));
  assert.ok(
    lines.includes("P released 30 tTEST at milestone 1 after 2 backers left."),
    lines.join("\n"),
  );
  assert.ok(
    lines.includes(
      "Everyone left before milestone 2 of P was settled, so nothing was released.",
    ),
  );
  assert.ok(
    lines.includes(
      "Milestone 3 of P was not settled in time, so nothing was released.",
    ),
  );
  assert.equal(
    lines.filter((l) =>
      l.startsWith("P posted a milestone. Backers can leave until"),
    ).length,
    3,
  );
});

test("the round: opened, settled, failed; and abandoned", () => {
  const items = backingFeedItems(
    [
      pool(
        [
          {
            kind: "round-opened",
            block: 1,
            logIndex: 0,
            tx: "",
            auction: A,
            supply: 1n,
            minimumRaise: 2_500n * ONE,
            endBlock: 9,
          },
          {
            kind: "round-settled",
            block: 2,
            logIndex: 0,
            tx: "",
            received: 3_000n * ONE,
            unitsSold: 10n ** 18n,
            clearingPriceX96: 1n,
            openingPrice: 1n,
          },
          {
            kind: "round-failed",
            block: 3,
            logIndex: 0,
            tx: "",
            raised: 1n,
            minimumRaise: 2n,
          },
          {
            kind: "abandoned",
            block: 4,
            logIndex: 0,
            tx: "",
            by: A,
            byVote: false,
            escrow: 1n,
          },
        ],
        { 1: NOON, 2: NOON + 1, 3: NOON + 2, 4: NOON + 3 },
      ),
    ],
    NOON + 10,
  );
  const lines = items.map((i) => backingFeedLine(i, "P")).reverse();
  assert.deepEqual(lines, [
    "P opened its round. It needs 2,500 tTEST for backing to open.",
    "P's round ended and backing opened, with 3,000 tTEST raised and 1 unit handed out.",
    "P's round did not reach its minimum. Bidders take their money back.",
    "P stopped releasing money, so backing has closed for good.",
  ]);
});

test("an event with no date is left out, and a date ahead of now is shown as now; items are newest first across pools", () => {
  const items = backingFeedItems(
    [
      pool([bought(10, A, ONE, 1n)], {}),
      {
        ...pool([posted(30, 1n, NOON + DAY)], { 30: NOON + 5 * DAY }),
        pool: "0xother",
        coordinate: "37001:bb:other",
      },
      {
        ...pool([resolved(31, 1n, true, ONE)], { 31: NOON - DAY }),
        pool: "0xthird",
      },
    ],
    NOON,
  );
  assert.deepEqual(
    items.map((i) => [i.pool, i.at]),
    [
      ["0xother", NOON],
      ["0xthird", NOON - DAY],
    ],
  );
});

test("a line says nothing of returns: the only price words are the price line on a buys card", () => {
  const items = backingFeedItems(
    [
      pool(
        [
          sold(1, 10n),
          bought(10, A, ONE, 20n),
          posted(30, 1n, NOON),
          resolved(31, 1n, true, ONE),
        ],
        { 1: NOON - DAY, 10: NOON, 30: NOON, 31: NOON },
      ),
    ],
    NOON + 10,
  );
  for (const item of items) {
    const line = backingFeedLine(item, "P");
    assert.doesNotMatch(line, /return|profit|gain|earn|yield/i, line);
    if (item.card.kind !== "backed") assert.doesNotMatch(line, /price/i, line);
  }
});
