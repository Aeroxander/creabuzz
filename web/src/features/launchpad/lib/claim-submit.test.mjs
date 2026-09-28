/**
 * `claim-submit.ts` under `node --test` (node >= 22 strip-types). The join:
 * launch record + unlock row + 47005 evidence -> composed ClaimStake calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evidenceHashWord,
  planClaimSubmit,
  planVerdictSubmit,
} from "./claim-submit.ts";
import {
  SELECTOR_ATTEST,
  SELECTOR_FUND,
  SELECTOR_SUBMIT_CLAIM,
  SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE,
} from "./claim-tx.ts";

const CLAIM_STAKE = "0xcccccccccccccccccccccccccccccccccccccccc";
const TREASURY = "0x1111111111111111111111111111111111111111";
const EVIDENCE = "a".repeat(64);

function record(overrides = {}) {
  return {
    claimStake: CLAIM_STAKE,
    treasury: TREASURY,
    tokenPlan: { mode: "mint", name: "P", symbol: "P", supply: "1000000" },
    unlocks: {
      mode: "milestones",
      allocationPct: 20,
      milestones: [
        {
          claim: "m1",
          label: "Testnet live",
          percent: 60,
          verifier: "founder",
        },
        { claim: "m2", label: "Mainnet", percent: 40, verifier: "founder" },
      ],
      months: null,
    },
    ...overrides,
  };
}

const ROW = {
  claim: "m1",
  label: "Testnet live",
  percent: 60,
  verifier: "founder",
};

describe("evidenceHashWord", () => {
  it("accepts 47005 style (no 0x) and 0x style alike", () => {
    assert.equal(evidenceHashWord(EVIDENCE), `0x${EVIDENCE}`);
    assert.equal(evidenceHashWord(`0x${EVIDENCE}`), `0x${EVIDENCE}`);
    assert.equal(evidenceHashWord("nope"), null);
  });
});

describe("planClaimSubmit", () => {
  it("composes the tranche claim and its escrow call", () => {
    const plan = planClaimSubmit({
      record: record(),
      row: ROW,
      evidenceHash: EVIDENCE,
    });
    assert.ok(plan);
    assert.equal(plan.claimStake, CLAIM_STAKE);
    assert.equal(plan.amount, "120000"); // 20% * 60% of 1,000,000
    assert.ok(plan.call.data.startsWith(SELECTOR_SUBMIT_CLAIM));
    assert.equal(plan.call.to, CLAIM_STAKE);
    assert.ok(plan.fundCall.data.startsWith(SELECTOR_FUND));
    assert.equal(plan.fundCall.value, "0x0");
  });

  it("rides a royalty schedule when given (allocation = tranche)", () => {
    const plan = planClaimSubmit({
      record: record(),
      row: ROW,
      evidenceHash: EVIDENCE,
      schedule: { weight: 1, term: 365 * 86400, band: 1 },
    });
    assert.ok(plan);
    assert.ok(plan.call.data.startsWith(SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE));
  });

  it("returns null rather than guessing an unwired record", () => {
    assert.equal(
      planClaimSubmit({
        record: record({ claimStake: null }),
        row: ROW,
        evidenceHash: EVIDENCE,
      }),
      null,
    );
    assert.equal(
      planClaimSubmit({
        record: record({ tokenPlan: null }),
        row: ROW,
        evidenceHash: EVIDENCE,
      }),
      null,
    );
    assert.equal(
      planClaimSubmit({
        record: record({
          unlocks: { ...record().unlocks, mode: "time", months: 3 },
        }),
        row: ROW,
        evidenceHash: EVIDENCE,
      }),
      null,
    );
    assert.equal(
      planClaimSubmit({
        record: record(),
        row: { ...ROW, claim: "m9" }, // not a row of the plan
        evidenceHash: EVIDENCE,
      }),
      null,
    );
    assert.equal(
      planClaimSubmit({ record: record(), row: ROW, evidenceHash: "short" }),
      null,
    );
    assert.equal(
      planClaimSubmit({
        record: record({ treasury: null }),
        row: ROW,
        evidenceHash: EVIDENCE,
      }),
      null,
    );
  });
});

describe("planVerdictSubmit", () => {
  const VERIFIER_SET = "0x2222222222222222222222222222222222222222";

  it("composes attest(claimId, approve) on the record's VerifierSet", () => {
    const call = planVerdictSubmit({ verifierSet: VERIFIER_SET }, "m1", true);
    assert.ok(call);
    assert.equal(call.to, VERIFIER_SET);
    assert.ok(call.data.startsWith(SELECTOR_ATTEST));
    // m1 word, then the bool word 0x…01.
    assert.equal(
      call.data.slice(10, 74),
      "6d31000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(call.data.slice(74).endsWith("1"), true);
  });

  it("reject = the zero bool word", () => {
    const call = planVerdictSubmit({ verifierSet: VERIFIER_SET }, "m1", false);
    assert.ok(call);
    assert.equal(call.data.slice(74).endsWith("0"), true);
  });

  it("returns null unwired or malformed", () => {
    assert.equal(planVerdictSubmit({ verifierSet: null }, "m1", true), null);
    assert.equal(
      planVerdictSubmit({ verifierSet: VERIFIER_SET }, "", true),
      null,
    );
  });
});
