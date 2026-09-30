// Tests for budget consumption windowing (NIP-ORG §37012 epoch mapping).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/budgetConsumption.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  METRIC_FETCH_LIMIT,
  budgetWindowStart,
  consumptionPercentage,
  summarizeConsumption,
} from "./budgetConsumption.ts";

const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;

describe("budgetWindowStart", () => {
  it("day window floors to midnight UTC", () => {
    assert.equal(budgetWindowStart("day", DAY), DAY);
    assert.equal(budgetWindowStart("day", DAY + 1), DAY);
    assert.equal(budgetWindowStart("day", 2 * DAY - 1), DAY);
    assert.equal(budgetWindowStart("day", 0), 0);
  });

  it("week window floors to the unix week boundary", () => {
    assert.equal(budgetWindowStart("week", WEEK), WEEK);
    assert.equal(budgetWindowStart("week", WEEK + WEEK - 1), WEEK);
  });

  it("month window uses the 30-day NIP-ORG epoch mapping", () => {
    assert.equal(budgetWindowStart("month", MONTH), MONTH);
    assert.equal(budgetWindowStart("month", MONTH + 1), MONTH);
  });

  it("epoch window has no time-derived boundary (all-time)", () => {
    assert.equal(budgetWindowStart("epoch", 12345), null);
  });

  it("window start boundary is inclusive (zero-delay edge: now == start)", () => {
    // An event stamped exactly at the window boundary counts.
    const start = budgetWindowStart("day", DAY + 1);
    assert.equal(start, DAY);
    const summary = summarizeConsumption([{ created_at: DAY }], {
      window: "day",
      nowSeconds: DAY + 1,
    });
    assert.equal(summary.consumed, 1);
  });
});

describe("summarizeConsumption", () => {
  const NOW = 5 * DAY + 100;

  it("counts only events inside the window", () => {
    const events = [
      { created_at: 4 * DAY - 1 }, // previous window
      { created_at: 4 * DAY + 23 }, // previous window
      { created_at: 5 * DAY }, // window boundary — inside
      { created_at: NOW },
    ];
    const summary = summarizeConsumption(events, {
      window: "day",
      runsLimit: 10,
      nowSeconds: NOW,
    });
    assert.equal(summary.consumed, 2);
    assert.equal(summary.limit, 10);
    assert.equal(summary.truncated, false);
    assert.equal(summary.windowStart, 5 * DAY);
  });

  it("epoch windows count all events", () => {
    const events = [
      { created_at: 1 },
      { created_at: 2 * WEEK },
      { created_at: NOW },
    ];
    const summary = summarizeConsumption(events, {
      window: "epoch",
      runsLimit: 50,
      nowSeconds: NOW,
    });
    assert.equal(summary.consumed, 3);
    assert.equal(summary.windowStart, null);
  });

  it("ignores malformed events instead of crashing", () => {
    const events = [
      { created_at: NOW },
      {},
      { created_at: "yesterday" },
      { created_at: Number.NaN },
      null,
      undefined,
    ];
    const summary = summarizeConsumption(events, {
      window: "day",
      runsLimit: 2,
      nowSeconds: NOW,
    });
    assert.equal(summary.consumed, 1);
  });

  it("treats a non-numeric runs limit as absent", () => {
    for (const runsLimit of [undefined, Number.NaN, "10", null]) {
      const summary = summarizeConsumption([{ created_at: NOW }], {
        window: "day",
        runsLimit,
        nowSeconds: NOW,
      });
      assert.equal(summary.limit, undefined, `runsLimit: ${String(runsLimit)}`);
    }
  });

  it("keeps a zero runs limit (nothing allowed autonomously)", () => {
    const summary = summarizeConsumption([{ created_at: NOW }], {
      window: "day",
      runsLimit: 0,
      nowSeconds: NOW,
    });
    assert.equal(summary.limit, 0);
    assert.equal(consumptionPercentage(summary), null);
  });

  it("marks a full fetch page as truncated", () => {
    const events = Array.from({ length: METRIC_FETCH_LIMIT }, (_, i) => ({
      created_at: NOW - i,
    }));
    const summary = summarizeConsumption(events, {
      window: "epoch",
      runsLimit: 1000,
      nowSeconds: NOW,
      hitFetchLimit: true,
    });
    assert.equal(summary.consumed, METRIC_FETCH_LIMIT);
    assert.equal(summary.truncated, true);
  });
});

describe("consumptionPercentage", () => {
  it("computes 0-100 percentage against the runs ceiling", () => {
    assert.equal(
      consumptionPercentage({
        consumed: 80,
        limit: 100,
        truncated: false,
        windowStart: 0,
      }),
      80,
    );
    assert.equal(
      consumptionPercentage({
        consumed: 0,
        limit: 100,
        truncated: false,
        windowStart: 0,
      }),
      0,
    );
  });

  it("returns null without a ceiling (advisory display)", () => {
    assert.equal(
      consumptionPercentage({
        consumed: 5,
        limit: undefined,
        truncated: false,
        windowStart: 0,
      }),
      null,
    );
    assert.equal(
      consumptionPercentage({
        consumed: 5,
        limit: 0,
        truncated: false,
        windowStart: 0,
      }),
      null,
    );
  });
});
