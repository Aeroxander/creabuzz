// Tests for the shared utilization threshold math (P0 item 3, reference §2.5).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/shared/ui/utilizationBar.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UTILIZATION_AMBER_THRESHOLD,
  UTILIZATION_RED_THRESHOLD,
  UTILIZATION_TONE_BAR_CLASS,
  summarizeUtilizations,
  utilizationPercentage,
  utilizationTone,
} from "./utilizationThresholds.ts";

describe("utilizationTone", () => {
  it("is ok (green) below the amber threshold", () => {
    assert.equal(utilizationTone(0), "ok");
    assert.equal(utilizationTone(1), "ok");
    assert.equal(utilizationTone(69.9), "ok");
  });

  it("turns amber exactly at 70% (>= threshold)", () => {
    assert.equal(utilizationTone(UTILIZATION_AMBER_THRESHOLD), "waiting");
    assert.equal(utilizationTone(89.9), "waiting");
  });

  it("turns red strictly above 90%", () => {
    assert.equal(utilizationTone(UTILIZATION_RED_THRESHOLD), "waiting");
    assert.equal(utilizationTone(UTILIZATION_RED_THRESHOLD + 0.1), "blocking");
    assert.equal(utilizationTone(100), "blocking");
    assert.equal(utilizationTone(140), "blocking");
  });

  it("never invents a severity for an unusable percentage", () => {
    for (const value of [null, undefined, Number.NaN, "80", Infinity]) {
      assert.equal(utilizationTone(value), "ok", `input: ${String(value)}`);
    }
  });

  it("routes every tone through the status token tier", () => {
    assert.deepEqual(Object.keys(UTILIZATION_TONE_BAR_CLASS).sort(), [
      "blocking",
      "ok",
      "waiting",
    ]);
    for (const fill of Object.values(UTILIZATION_TONE_BAR_CLASS)) {
      assert.match(fill, /^bg-status-/);
    }
  });
});

describe("utilizationPercentage", () => {
  it("computes the percentage against a positive ceiling", () => {
    assert.equal(utilizationPercentage(32, 50), 64);
    assert.equal(utilizationPercentage(0, 10), 0);
    assert.equal(utilizationPercentage(120, 100), 120); // over 100 is real
  });

  it("returns null without a usable ceiling (advisory display)", () => {
    for (const limit of [undefined, null, 0, -5, Number.NaN, "50"]) {
      assert.equal(
        utilizationPercentage(10, limit),
        null,
        `limit: ${String(limit)}`,
      );
    }
  });

  it("returns null for an unusable count", () => {
    for (const consumed of [Number.NaN, -1, undefined, null, "5"]) {
      assert.equal(
        utilizationPercentage(consumed, 10),
        null,
        `consumed: ${String(consumed)}`,
      );
    }
  });
});

describe("summarizeUtilizations", () => {
  it("picks the highest percentage as worst", () => {
    const summary = summarizeUtilizations([
      { percentage: 40, truncated: false },
      { percentage: 95, truncated: false },
      { percentage: 71, truncated: false },
    ]);
    assert.equal(summary.worstIndex, 1);
    // 95 and 71 are both >=70%; 40 is not.
    assert.equal(summary.attentionCount, 2);
  });

  it("counts truncated floors as attention but never as worst", () => {
    const summary = summarizeUtilizations([
      { percentage: 80, truncated: false },
      { percentage: null, truncated: true },
      { percentage: 30, truncated: true },
    ]);
    assert.equal(summary.worstIndex, 0);
    // 80% needs attention, and each truncated floor is its own unverifiable
    // item — three attention sources across three budgets.
    assert.equal(summary.attentionCount, 3);
  });

  it("never ranks an unknowable percentage (null) as worst", () => {
    const summary = summarizeUtilizations([
      { percentage: null, truncated: false },
      { percentage: 10, truncated: false },
    ]);
    assert.equal(summary.worstIndex, 1);
    assert.equal(summary.attentionCount, 0);
  });

  it("counts caller-flagged anomalies as attention", () => {
    const summary = summarizeUtilizations([
      { percentage: null, truncated: false, flagged: true },
    ]);
    assert.equal(summary.worstIndex, null);
    assert.equal(summary.attentionCount, 1);
  });

  it("handles an empty aggregate honestly", () => {
    const summary = summarizeUtilizations([]);
    assert.equal(summary.worstIndex, null);
    assert.equal(summary.attentionCount, 0);
  });
});
