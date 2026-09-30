/**
 * `enforced-check.ts` under `node --test` (node >= 22 strip-types) — the
 * anti-auditability-washing verification and its honesty rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SELECTOR_PROPOSAL_THRESHOLD,
  SELECTOR_RAGEQUITTABLE,
  verifyEnforced,
} from "../lib/enforced-check.ts";

const REGISTER = [
  {
    action: "propose",
    authority: "permitted",
    checkpoint: { kind: "policy-as-code", mechanism: "proposalThreshold" },
  },
  {
    action: "spend",
    authority: "conditional",
    checkpoint: { kind: "human-approval", approver: "46010" },
    onViolation: "decreaseAllowance",
  },
  {
    action: "exit",
    authority: "permitted",
    checkpoint: { kind: "policy-as-code", mechanism: "ragequit" },
  },
];

describe("selector pins (cast sig)", () => {
  it("proposalThreshold / ragequittable", () => {
    assert.equal(SELECTOR_PROPOSAL_THRESHOLD, "0xb58131b0");
    assert.equal(SELECTOR_RAGEQUITTABLE, "0x14a6d7de");
  });
});

describe("verifyEnforced — claims become checkable", () => {
  it("live mechanisms verify when they exist and are on", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 100n,
      ragequittable: true,
    });
    assert.equal(out[0].status, "verified");
    assert.match(out[0].detail, /proposalThreshold = 100/);
    assert.equal(out[2].status, "verified");
  });

  it("THE sharp case: a claimed exit right with ragequittable=false is contradicted", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 100n,
      ragequittable: false,
    });
    assert.equal(out[2].status, "contradicted");
    assert.match(out[2].detail, /exit right does not exist/);
  });

  it("threshold 0 contradicts the gating claim (anyone may propose)", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 0n,
      ragequittable: true,
    });
    assert.equal(out[0].status, "contradicted");
  });

  it("human-approval checkpoints are documented, never fake-verified", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 100n,
      ragequittable: true,
    });
    assert.equal(out[1].status, "documented");
    assert.match(out[1].detail, /46010/);
  });

  it("unreadable mechanisms are unverifiable — never green by default", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: null,
      ragequittable: null,
    });
    assert.equal(out[0].status, "unverifiable");
    assert.equal(out[2].status, "unverifiable");
  });

  it("unknown mechanisms are unverifiable, not blessed", () => {
    const out = verifyEnforced(
      [
        {
          action: "custom",
          checkpoint: { kind: "policy-as-code", mechanism: "mystery" },
        },
      ],
      { proposalThreshold: 1n, ragequittable: true },
    );
    assert.equal(out[0].status, "unverifiable");
  });
});
