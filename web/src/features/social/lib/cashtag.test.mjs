import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SPARK_POINTS,
  cashtagLabel,
  cashtagPrice,
  stageWords,
  tickerOwners,
} from "./cashtag.ts";
import { cashtagSymbols, tokenize } from "./content.ts";

const launch = (id, symbol, createdAt, over = {}) => ({
  record: {
    id,
    author: "aa",
    name: `Project ${id}`,
    createdAt,
    stage: "live",
    tokenPlan: symbol ? { symbol } : null,
    ...over,
  },
});

describe("cashtags in text", () => {
  it("finds a ticker, keeps prices as text, and upper-cases", () => {
    const types = (text) => tokenize(text).map((t) => t.type);
    assert.deepEqual(types("I like $create a lot"), [
      "text",
      "cashtag",
      "text",
    ]);
    assert.equal(
      tokenize("I like $create").find((t) => t.type === "cashtag").symbol,
      "CREATE",
    );
    // Money is not a ticker: a price starts with a digit.
    assert.deepEqual(types("it costs $5 or $100.50"), ["text"]);
    // A ticker is 2 to 8 characters, and must stand alone.
    assert.deepEqual(types("$a"), ["text"]);
    assert.deepEqual(types("$abcdefghi"), ["text"]);
    assert.deepEqual(types("price$ABC"), ["text"]);
    assert.deepEqual(types("$ABC$DEF"), ["text"]);
  });

  it("takes a ticker before punctuation and inside brackets", () => {
    assert.deepEqual(
      cashtagSymbols("($CREATE), then $buzz! and $CREATE again"),
      ["CREATE", "BUZZ"],
    );
  });

  it("leaves hashtags, links and mentions alone", () => {
    const text = "#buzz https://example.com/$ABC $ABC";
    assert.deepEqual(
      tokenize(text).map((t) => t.type),
      ["hashtag", "text", "link", "text", "cashtag"],
    );
  });
});

describe("which launch owns a ticker", () => {
  it("the first claim wins, case-insensitively, and a tie is broken the same everywhere", () => {
    const owners = tickerOwners([
      launch("late", "create", 200),
      launch("first", "CREATE", 100),
      launch("other", "BUZZ", 150),
    ]);
    assert.equal(owners.get("CREATE").record.id, "first");
    assert.equal(owners.get("BUZZ").record.id, "other");
    const tie = tickerOwners([launch("b", "TIE", 5), launch("a", "tie", 5)]);
    assert.equal(tie.get("TIE").record.id, "a");
    const reversed = tickerOwners([
      launch("a", "tie", 5),
      launch("b", "TIE", 5),
    ]);
    assert.equal(reversed.get("TIE").record.id, "a");
  });

  it("a launch with no token plan claims nothing, and an unclaimed ticker resolves to nothing", () => {
    const owners = tickerOwners([launch("x", null, 1), launch("y", "  ", 2)]);
    assert.equal(owners.size, 0);
    assert.equal(owners.get("NOPE"), undefined);
  });

  it("says where the launch is in plain words", () => {
    assert.equal(
      cashtagLabel(
        "CREATE",
        launch("first", "CREATE", 1, { stage: "funding" }),
      ),
      "$CREATE: Project first, raising now",
    );
    assert.equal(stageWords("graduated"), "launched");
    assert.equal(stageWords("mystery"), "mystery");
  });
});

describe("the price a chip shows", () => {
  // `toPrice` stands in for the Q96 conversion: the stored string is already the price.
  const toPrice = (q) => (q === null ? null : Number(q) || null);

  it("is the latest recorded bid, newest last, and says so", () => {
    const price = cashtagPrice(
      {
        bids: [
          { createdAt: 30, maxPrice: "0.03" },
          { createdAt: 10, maxPrice: "0.01" },
          { createdAt: 20, maxPrice: "0.02" },
        ],
        floorPrice: "0.005",
      },
      toPrice,
    );
    assert.deepEqual(price, {
      source: "bids",
      latest: 0.03,
      points: [0.01, 0.02, 0.03],
    });
    const label = cashtagLabel("NEB", launch("a", "NEB", 1), {
      price,
      unit: "USDC",
      text: "0.03",
    });
    assert.match(
      label,
      /Highest recent bid price 0\.03 USDC per token, not a market trade/,
    );
  });

  it("falls back to the sale's starting price when nobody has bid, never to an invented number", () => {
    assert.deepEqual(cashtagPrice({ bids: [], floorPrice: "0.005" }, toPrice), {
      source: "floor",
      latest: 0.005,
      points: [0.005],
    });
    assert.equal(cashtagPrice({ bids: [], floorPrice: null }, toPrice), null);
    // A bid whose price cannot be read is skipped, not drawn as zero.
    assert.deepEqual(
      cashtagPrice(
        {
          bids: [
            { createdAt: 1, maxPrice: "nope" },
            { createdAt: 2, maxPrice: "0.02" },
          ],
          floorPrice: null,
        },
        toPrice,
      )?.points,
      [0.02],
    );
  });

  it("keeps only the newest few bids", () => {
    const bids = Array.from({ length: SPARK_POINTS + 5 }, (_, i) => ({
      createdAt: i,
      maxPrice: String(i + 1),
    }));
    const price = cashtagPrice({ bids, floorPrice: null }, toPrice);
    assert.equal(price.points.length, SPARK_POINTS);
    assert.equal(price.latest, SPARK_POINTS + 5);
  });
});
