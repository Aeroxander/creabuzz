/**
 * `claimChoices.ts` under `node --test` (desktop: run via the repo's test
 * script) — the derived-choices layer and its honesty rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { autoFill, milestoneChoices } from "./claimChoices.ts";

const EVIDENCE = "a".repeat(64);
const TX_1 = `0x${"1".repeat(64)}`;

function receipt(table, claim, evidenceHash, tx, createdAt) {
  return {
    table,
    tx,
    payload: evidenceHash ? { claim, evidenceHash } : { claim },
    createdAt,
  };
}

describe("milestoneChoices", () => {
  it("derives claim options from the plan with labels", () => {
    const choices = milestoneChoices(
      {
        mode: "milestones",
        milestones: [{ claim: "m1", label: "Testnet live" }],
      },
      [],
    );
    assert.deepEqual(choices.claimOptions, [
      { value: "m1", label: "m1 — Testnet live" },
    ]);
  });

  it("schedule ids are bytes32 words (schedules(bytes32) keys)", () => {
    const choices = milestoneChoices(null, [
      receipt("claim", "m1", EVIDENCE, TX_1, 1),
    ]);
    assert.deepEqual(choices.scheduleIds, [
      "0x6d31000000000000000000000000000000000000000000000000000000000000",
    ]);
  });

  it("drops malformed values and never guesses", () => {
    const choices = milestoneChoices(null, [
      receipt("claim", "m1", "not-hex", "0x1234", 5),
    ]);
    assert.deepEqual(choices.evidenceByClaim.m1 ?? [], []);
    assert.deepEqual(choices.txByClaim.m1 ?? [], []);
    assert.deepEqual(choices.scheduleIds, []);
    assert.deepEqual(autoFill(choices, "m1"), {
      evidenceHash: undefined,
      txHash: undefined,
    });
  });

  it("autoFill picks the newest known pair", () => {
    const choices = milestoneChoices(null, [
      receipt("claim", "m1", EVIDENCE, TX_1, 1),
      receipt("claim", "m1", "b".repeat(64), `0x${"2".repeat(64)}`, 9),
    ]);
    assert.deepEqual(autoFill(choices, "m1"), {
      evidenceHash: "b".repeat(64),
      txHash: `0x${"2".repeat(64)}`,
    });
  });
});
