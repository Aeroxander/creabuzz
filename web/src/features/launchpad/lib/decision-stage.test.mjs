import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decisionStage, duration, isLive } from "./decision-stage.ts";

const decision = (over = {}) => ({
  id: `0x${"01".repeat(32)}`,
  state: "Active",
  proposer: "0x0",
  openedAt: 1,
  queuedAt: 0,
  rules: null,
  support: { yes: 0n, no: 0n, abstain: 0n },
  action: null,
  openedBy: null,
  ...over,
});
const rules = { delay: 86_400n, reviewEndsAt: 2_000n };

describe("decisionStage", () => {
  it("says where each state stands, and the one step anyone can take", () => {
    const table = [
      [{ state: "Executed" }, "Done", "done", null],
      [{ state: "Expired" }, "Expired", "bad", null],
      [{ state: "Defeated" }, "Rejected", "bad", null],
      [{ state: "Queued", queuedAt: 5, rules }, "Waiting to run", "wait", null],
      [{ state: "Succeeded", queuedAt: 0, rules }, "Approved", "good", "start"],
      [
        { state: "Succeeded", queuedAt: 5, rules },
        "Ready to run",
        "good",
        "run",
      ],
      [{ state: "Active", rules }, "Collecting support", "open", null],
    ];
    for (const [over, label, tone, step] of table) {
      const stage = decisionStage(decision(over), 1_000);
      assert.equal(stage.label, label, over.state);
      assert.equal(stage.tone, tone, over.state);
      assert.equal(stage.step, step, over.state);
    }
  });

  it("says nothing can run before the review ends, then that support has to hold", () => {
    assert.match(
      decisionStage(decision({ rules }), 1_000).next,
      /Nothing can run before/,
    );
    assert.match(
      decisionStage(decision({ rules }), 3_000).next,
      /needs enough support/,
    );
  });

  it("names the wait in days for an approved decision", () => {
    assert.match(
      decisionStage(decision({ state: "Succeeded", rules }), 0).next,
      /1 day wait/,
    );
  });
});

describe("isLive", () => {
  it("is true while a decision can still change and false once it is over", () => {
    for (const state of ["Active", "Succeeded", "Queued"])
      assert.equal(isLive({ state }), true, state);
    for (const state of ["Executed", "Expired", "Defeated"])
      assert.equal(isLive({ state }), false, state);
  });
});

describe("duration", () => {
  it("uses the largest whole unit", () => {
    assert.equal(duration(86_400n), "1 day");
    assert.equal(duration(172_800n), "2 days");
    assert.equal(duration(3_600n), "1 hour");
    assert.equal(duration(120n), "2 minutes");
    assert.equal(duration(90n), "90 seconds");
  });
});
