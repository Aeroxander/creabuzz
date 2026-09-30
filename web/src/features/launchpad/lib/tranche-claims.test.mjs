/**
 * `tranche-claims.ts` under `node --test` (run with node >= 22 strip-types).
 * Goldens and floor math for the wizard-unlock -> ClaimStake join.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claimIdWord,
  scheduleRequestIssues,
  trancheAmount,
  trancheClaims,
} from "./tranche-claims.ts";

function plan(overrides = {}) {
  return {
    mode: "milestones",
    allocationPct: 20,
    milestones: [
      { claim: "m1", label: "Testnet live", percent: 60, verifier: "founder" },
      { claim: "m2", label: "Mainnet", percent: 40, verifier: "founder" },
    ],
    months: null,
    ...overrides,
  };
}

describe("claimIdWord", () => {
  it("right-pads ASCII to 32 bytes (m1 golden)", () => {
    assert.equal(
      claimIdWord("m1"),
      "0x6d31000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("keeps a full 32-char id whole", () => {
    const id = "abcdefghijklmnopqrstuvwxyz012345";
    const word = claimIdWord(id);
    assert.equal(word.length, 66);
    assert.equal(
      word,
      `0x${Array.from(id, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`,
    );
  });

  it("refuses empty, oversized, and non-printable ids", () => {
    assert.throws(() => claimIdWord(""), /1-32 printable ASCII/);
    assert.throws(() => claimIdWord("x".repeat(33)), /1-32 printable ASCII/);
    assert.throws(
      () => claimIdWord(`m${String.fromCharCode(0)}1`),
      /1-32 printable ASCII/,
    );
    assert.throws(() => claimIdWord("m\n1"), /1-32 printable ASCII/);
  });
});

describe("trancheAmount", () => {
  it("single floor: supply * allocationPct * percent / 10000", () => {
    assert.equal(trancheAmount(1_000_000n, 20, 25), 50_000n);
  });

  it("floors once, not per step", () => {
    // 999 * 33 * 33 / 10000 = 108.7911 -> 108 (a per-step floor could lose
    // more; one floor keeps the reported remainder honest).
    assert.equal(trancheAmount(999n, 33, 33), 108n);
  });

  it("refuses fractional or out-of-range percents", () => {
    assert.throws(() => trancheAmount(100n, 20.5, 50), /integers in 0..100/);
    assert.throws(() => trancheAmount(100n, 101, 50), /integers in 0..100/);
    assert.throws(() => trancheAmount(100n, 10, -1), /integers in 0..100/);
  });
});

describe("scheduleRequestIssues", () => {
  it("mirrors the contract band caps", () => {
    assert.deepEqual(
      scheduleRequestIssues({ weight: 1, term: 365 * 86400, band: 1 }),
      [],
    );
    assert.equal(
      scheduleRequestIssues({ weight: 2, term: 86400, band: 1 }).length,
      1,
    );
    assert.equal(
      scheduleRequestIssues({ weight: 1, term: 730 * 86400, band: 1 }).length,
      1,
    );
    assert.deepEqual(
      scheduleRequestIssues({ weight: 3, term: 1095 * 86400, band: 3 }),
      [],
    );
    assert.equal(
      scheduleRequestIssues({ weight: 1, term: 86400, band: 4 }).length,
      1,
    );
  });
});

describe("trancheClaims", () => {
  it("maps milestone rows to claims with amounts and escrow total", () => {
    const out = trancheClaims(plan(), 1_000_000n);
    assert.equal(out.claims.length, 2);
    assert.equal(out.claims[0].claimIdWord.slice(0, 6), "0x6d31");
    assert.equal(out.claims[0].amount, "120000"); // 20% * 60%
    assert.equal(out.claims[1].amount, "80000");
    assert.equal(out.escrowRequired, "200000");
    assert.equal(out.flooredRemainder, "0");
  });

  it("reports floor dust instead of reassigning it", () => {
    const out = trancheClaims(plan({ allocationPct: 33 }), 999n);
    // rows: floor(999*33*60/10000)=197, floor(999*33*40/10000)=131; ideal=329
    assert.equal(out.claims[0].amount, "197");
    assert.equal(out.claims[1].amount, "131");
    assert.equal(out.escrowRequired, "328");
    assert.equal(out.flooredRemainder, "1");
  });

  it("rides schedules when asked and refuses bad ones", () => {
    const ok = trancheClaims(plan(), 1_000_000n, {
      m1: { weight: 1, term: 365 * 86400, band: 1 },
    });
    assert.equal(ok.claims[0].schedule?.band, 1);
    assert.equal(ok.claims[1].schedule, null);
    assert.throws(
      () =>
        trancheClaims(plan(), 1_000_000n, {
          m1: { weight: 5, term: 365 * 86400, band: 1 },
        }),
      /bad schedule for m1/,
    );
  });

  it("time and none modes produce no claims (record-level by design)", () => {
    assert.equal(
      trancheClaims(plan({ mode: "time", months: 3 }), 1_000_000n).claims
        .length,
      0,
    );
    assert.equal(
      trancheClaims(plan({ mode: "none", milestones: [] }), 1_000_000n).claims
        .length,
      0,
    );
  });

  it("refuses an invalid plan loudly", () => {
    assert.throws(
      () =>
        trancheClaims(
          plan({
            milestones: [
              { claim: "m1", label: "", percent: 100, verifier: "founder" },
            ],
          }),
          1000n,
        ),
      /invalid unlock plan/,
    );
  });
});
