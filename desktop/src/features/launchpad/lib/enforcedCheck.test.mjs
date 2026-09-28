/**
 * Desktop `enforcedCheck.ts` under `node --test` — the anti-auditability-
 * washing verification (web parity) and its honesty rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseEnforcedRegister,
  relayHttpUrl,
  SELECTOR_PROPOSAL_THRESHOLD,
  SELECTOR_RAGEQUITTABLE,
  verifyEnforced,
} from "./enforcedCheck.ts";

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
  it("proposalThreshold / ragequittable / shares", () => {
    assert.equal(SELECTOR_PROPOSAL_THRESHOLD, "0xb58131b0");
    assert.equal(SELECTOR_RAGEQUITTABLE, "0x14a6d7de");
  });
});

describe("verifyEnforced", () => {
  it("live mechanisms verify when they exist and are on", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 100n,
      ragequittable: true,
    });
    assert.equal(out[0].status, "verified");
    assert.equal(out[2].status, "verified");
  });

  it("THE sharp case: claimed exit + ragequittable=false = contradicted", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 100n,
      ragequittable: false,
    });
    assert.equal(out[2].status, "contradicted");
    assert.match(out[2].detail, /exit right does not exist/);
  });

  it("human-approval checkpoints are documented, never fake-verified", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: 100n,
      ragequittable: true,
    });
    assert.equal(out[1].status, "documented");
    assert.match(out[1].detail, /46010/);
  });

  it("unreadable = unverifiable; unknown mechanisms are not blessed", () => {
    const out = verifyEnforced(REGISTER, {
      proposalThreshold: null,
      ragequittable: null,
    });
    assert.equal(out[0].status, "unverifiable");
    assert.equal(out[2].status, "unverifiable");
    const unknown = verifyEnforced(
      [
        {
          action: "custom",
          checkpoint: { kind: "policy-as-code", mechanism: "mystery" },
        },
      ],
      { proposalThreshold: 1n, ragequittable: true },
    );
    assert.equal(unknown[0].status, "unverifiable");
  });
});

describe("served-document helpers", () => {
  it("relayHttpUrl keeps origin and swaps the scheme", () => {
    assert.equal(relayHttpUrl("wss://relay.example/"), "https://relay.example");
    assert.equal(relayHttpUrl("ws://localhost:8080/"), "http://localhost:8080");
  });

  it("parseEnforcedRegister extracts the claim or returns null (never guesses)", () => {
    const body = { extensions: { "x-ao.enforced": REGISTER } };
    assert.equal(parseEnforcedRegister(body)?.length, 3);
    assert.equal(parseEnforcedRegister({}), null);
    assert.equal(parseEnforcedRegister(null), null);
    assert.equal(
      parseEnforcedRegister({ extensions: { "x-ao.enforced": "nope" } }),
      null,
    );
  });
});
