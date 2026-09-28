/**
 * `claim-choices.ts` under `node --test` (node >= 22 strip-types) — the
 * "no manual hashes" derivation and its honesty rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { autoFill, milestoneChoices } from "../lib/claim-choices.ts";

const EVIDENCE_A = "a".repeat(64);
const EVIDENCE_B = "b".repeat(64);
const TX_1 = `0x${"1".repeat(64)}`;
const TX_2 = `0x${"2".repeat(64)}`;

function unlocks() {
  return {
    mode: "milestones",
    milestones: [
      { claim: "m1", label: "Testnet live" },
      { claim: "m2", label: "Mainnet" },
    ],
  };
}

function receipt(table, claim, evidenceHash, tx, createdAt) {
  return {
    table,
    tx,
    payload: evidenceHash ? { claim, evidenceHash } : { claim },
    createdAt,
  };
}

describe("milestoneChoices", () => {
  it("derives claim options from the plan with labels, then receipts", () => {
    const choices = milestoneChoices(unlocks(), [
      receipt("claim", "m3", EVIDENCE_A, TX_1, 5),
    ]);
    assert.deepEqual(choices.claimOptions, [
      { value: "m1", label: "m1 — Testnet live" },
      { value: "m2", label: "m2 — Mainnet" },
      { value: "m3", label: "m3 (recorded)" },
    ]);
  });

  it("sources evidence and tx per claim, newest first, deduped", () => {
    const choices = milestoneChoices(unlocks(), [
      receipt("claim", "m1", EVIDENCE_A, TX_1, 1),
      receipt("claim", "m1", EVIDENCE_B, TX_2, 9),
      receipt("verdict", "m1", null, TX_2, 8),
    ]);
    assert.deepEqual(choices.evidenceByClaim.m1, [EVIDENCE_B, EVIDENCE_A]);
    assert.deepEqual(choices.txByClaim.m1, [TX_2, TX_1]);
  });

  it("drops malformed values instead of offering them", () => {
    const choices = milestoneChoices(unlocks(), [
      receipt("claim", "m1", "not-hex", "0x1234", 5),
    ]);
    assert.deepEqual(choices.evidenceByClaim.m1 ?? [], []);
    assert.deepEqual(choices.txByClaim.m1 ?? [], []);
  });

  it("schedule ids are the bytes32 WORDS `schedules(bytes32)` is keyed by", () => {
    const choices = milestoneChoices(unlocks(), [
      receipt("claim", "m1", EVIDENCE_A, TX_1, 1),
      receipt("verdict", "m2", null, TX_2, 2),
    ]);
    assert.deepEqual(choices.scheduleIds, [
      "0x6d31000000000000000000000000000000000000000000000000000000000000",
    ]);
  });
});

describe("autoFill (the one-dropdown journey)", () => {
  it("fills the newest known pair and never invents", () => {
    const choices = milestoneChoices(unlocks(), [
      receipt("claim", "m1", EVIDENCE_A, TX_1, 1),
      receipt("claim", "m1", EVIDENCE_B, TX_2, 9),
    ]);
    assert.deepEqual(autoFill(choices, "m1"), {
      evidenceHash: EVIDENCE_B,
      txHash: TX_2,
    });
    assert.deepEqual(autoFill(choices, "m2"), {
      evidenceHash: undefined,
      txHash: undefined,
    });
  });
});
