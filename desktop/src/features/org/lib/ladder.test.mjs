// Tests for the NIP-ORG performance-ladder pure resolution.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/ladder.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ladderWindowStart,
  countLadderOutcomes,
  resolveLadder,
} from "./ladder.ts";

const SUBJECT = "a".repeat(64);

function record(overrides = {}) {
  return {
    eventId: "evt-1",
    author: SUBJECT,
    dtag: "action-1",
    action: "x",
    dimensions: { build: 0.5 },
    evidence: [],
    humanVsAi: { human: 0, ai: 1 },
    informedBy: [],
    reviewStatus: "pending",
    appealHistory: [],
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

const link = {
  window: "week",
  dimensions: ["build"],
  tiers: [
    { minAccepted: 3, limits: { runs: 80 } },
    { minAccepted: 10, limits: { runs: 200 } },
  ],
  onViolation: "revoke",
  violationThreshold: { rejected: 1 },
};

describe("ladderWindowStart", () => {
  it("epoch is cumulative", () => {
    assert.equal(ladderWindowStart("epoch", 1_700_000_000), 0);
  });
  it("week starts at the most recent Monday (UTC)", () => {
    // 2025-10-14 is a Tuesday.
    const tuesday = Date.UTC(2025, 9, 14, 12, 0, 0) / 1000;
    const monday = Date.UTC(2025, 9, 13, 0, 0, 0) / 1000;
    assert.equal(ladderWindowStart("week", tuesday), monday);
  });
  it("month starts on the 1st UTC", () => {
    const mid = Date.UTC(2025, 9, 21, 5, 30, 0) / 1000;
    assert.equal(ladderWindowStart("month", mid), Date.UTC(2025, 9, 1) / 1000);
  });
});

describe("countLadderOutcomes", () => {
  it("counts only the subject's accepted/rejected in the window, filtered by dimension", () => {
    const weekStart = ladderWindowStart("week", 1_700_000_000);
    const records = [
      record({ reviewStatus: "accepted", createdAt: weekStart + 10 }),
      record({ reviewStatus: "accepted", createdAt: weekStart + 20, dimensions: { teach: 1 } }),
      record({ reviewStatus: "rejected", createdAt: weekStart + 30 }),
      record({ reviewStatus: "pending", createdAt: weekStart + 40 }),
      record({ reviewStatus: "accepted", createdAt: weekStart - 1 }), // outside window
      record({ reviewStatus: "accepted", createdAt: weekStart + 50, author: "b".repeat(64) }),
    ];
    const counts = countLadderOutcomes(SUBJECT, link, records, 1_700_000_000);
    // Accepted: first record (build, in-window, subject). Rejected: third
    // record (build, in-window, subject). Teach-dimension, out-of-window,
    // pending, and other-author records are excluded.
    assert.deepEqual(counts, { accepted: 1, rejected: 1 });
  });
});

describe("resolveLadder", () => {
  const base = { runs: 50 };

  it("base limits below the first tier; tiers rise with accepted count", () => {
    let r = resolveLadder(link, { accepted: 2, rejected: 0 }, base);
    assert.equal(r.tier, null);
    assert.equal(r.activeLimits.runs, 50);
    assert.equal(r.nextTierMin, 3);

    r = resolveLadder(link, { accepted: 5, rejected: 0 }, base);
    assert.equal(r.tier, 0);
    assert.equal(r.activeLimits.runs, 80);
    assert.equal(r.nextTierMin, 10);

    r = resolveLadder(link, { accepted: 20, rejected: 0 }, base);
    assert.equal(r.tier, 1);
    assert.equal(r.activeLimits.runs, 200);
    assert.equal(r.nextTierMin, null);
  });

  it("violation collapses to zeroed limits under revoke", () => {
    const r = resolveLadder(link, { accepted: 30, rejected: 1 }, base);
    assert.ok(r.violated);
    assert.ok(r.zeroed);
    assert.equal(r.activeLimits.runs, 0);
    assert.equal(r.tier, null);
  });

  it("violation with onViolation base falls back to base limits", () => {
    const soft = { ...link, onViolation: "base" };
    const r = resolveLadder(soft, { accepted: 30, rejected: 1 }, base);
    assert.ok(r.violated);
    assert.equal(r.zeroed, false);
    assert.equal(r.activeLimits.runs, 50);
  });

  it("no threshold means rejections never gate the ladder", () => {
    const noThreshold = { ...link, violationThreshold: undefined };
    const r = resolveLadder(noThreshold, { accepted: 3, rejected: 9 }, base);
    assert.ok(!r.violated);
    assert.equal(r.tier, 0);
  });
});
