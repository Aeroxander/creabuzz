// Tests for the org onboarding wizard state machine (lib/orgWizard.ts).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/orgWizard.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WIZARD_STEPS,
  canFinish,
  currentStepId,
  initialWizardState,
  positionOf,
  recordOutcome,
  reviewRows,
  skipStep,
  stepStatus,
} from "./orgWizard.ts";

function rootOutcome(dtag = "acme") {
  return {
    step: "root",
    kind: "node",
    dtag,
    name: "Acme",
    nodeKind: "role",
  };
}

describe("step strip positions are counted, not indexed", () => {
  it("positions run 1..5 in strip order", () => {
    assert.deepEqual(
      WIZARD_STEPS.map((step) => step.position),
      [1, 2, 3, 4, 5],
    );
  });
  it("every step id resolves to its counted position", () => {
    assert.equal(positionOf("root"), 1);
    assert.equal(positionOf("seat"), 2);
    assert.equal(positionOf("grant"), 3);
    assert.equal(positionOf("budget"), 4);
    assert.equal(positionOf("review"), 5);
  });
});

describe("state transitions", () => {
  it("starts at position 1 (Name the org root)", () => {
    const state = initialWizardState();
    assert.equal(state.position, 1);
    assert.equal(currentStepId(state), "root");
  });
  it("completing the root advances to the seat step", () => {
    const state = recordOutcome(initialWizardState(), "root", rootOutcome());
    assert.equal(state.position, 2);
    assert.equal(currentStepId(state), "seat");
  });
  it("skipping the seat keeps its counted position and advances to grant", () => {
    const state = skipStep(
      recordOutcome(initialWizardState(), "root", rootOutcome()),
      "seat",
    );
    assert.equal(state.position, 3);
    assert.equal(positionOf("seat"), 2);
    assert.equal(currentStepId(state), "grant");
  });
  it("skipping the root is refused", () => {
    const state = skipStep(initialWizardState(), "root");
    assert.equal(state.position, 1);
    assert.equal(currentStepId(state), "root");
  });
  it("completing every step lands on review", () => {
    let state = recordOutcome(initialWizardState(), "root", rootOutcome());
    state = skipStep(state, "seat");
    state = skipStep(state, "grant");
    state = skipStep(state, "budget");
    assert.equal(state.position, 5);
    assert.equal(currentStepId(state), "review");
  });
  it("advancing past review clamps at review", () => {
    const done = skipStep(
      skipStep(
        skipStep(
          recordOutcome(initialWizardState(), "root", rootOutcome()),
          "seat",
        ),
        "grant",
      ),
      "budget",
    );
    const again = recordOutcome(done, "root", rootOutcome());
    assert.equal(again.position, 5);
    assert.equal(currentStepId(again), "review");
  });
});

describe("step status", () => {
  it("pending before reaching a future step", () => {
    const state = initialWizardState();
    assert.equal(stepStatus(state, "budget"), "pending");
  });
  it("active for the current position", () => {
    const state = initialWizardState();
    assert.equal(stepStatus(state, "root"), "active");
  });
  it("complete after an outcome is recorded", () => {
    const state = recordOutcome(initialWizardState(), "root", rootOutcome());
    assert.equal(stepStatus(state, "root"), "complete");
    assert.equal(stepStatus(state, "seat"), "active");
  });
  it("skipped after a skip outcome", () => {
    let state = recordOutcome(initialWizardState(), "root", rootOutcome());
    state = skipStep(state, "seat");
    assert.equal(stepStatus(state, "seat"), "skipped");
  });
  it("a passed but unresolved step reads as skipped", () => {
    const state = recordOutcome(initialWizardState(), "root", rootOutcome());
    assert.equal(stepStatus(state, "grant"), "pending");
    const jumped = { ...state, position: 5 };
    assert.equal(stepStatus(jumped, "grant"), "skipped");
  });
});

describe("review rows", () => {
  it("lists steps 1-4 in strip order with positions", () => {
    const rows = reviewRows(initialWizardState());
    assert.deepEqual(
      rows.map((row) => row.position),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      rows.map((row) => row.title),
      [
        "Name the org root",
        "Add a role or agent seat",
        "First grant",
        "First budget",
      ],
    );
  });
  it("skipped steps carry a skip outcome; created outcomes carry entity data", () => {
    let state = recordOutcome(
      initialWizardState(),
      "root",
      rootOutcome("acme"),
    );
    state = recordOutcome(state, "grant", {
      step: "grant",
      kind: "grant",
      dtag: "g-1",
      grantee: "a".repeat(64),
      via: "acme",
      verbs: ["read"],
    });
    state = skipStep(state, "budget");
    const rows = reviewRows(state);
    assert.equal(rows[0].outcome?.step, "root");
    assert.equal(rows[0].outcome?.kind, "node");
    assert.equal(rows[2].outcome?.step, "grant");
    assert.equal(rows[3].outcome?.step, "skipped");
    assert.equal(rows[1].outcome ?? null, null); // seat never resolved (skipped by position)
  });
});

describe("finish gate", () => {
  it("requires the review to be reached with a real root", () => {
    assert.equal(canFinish(initialWizardState()), false);
    const done = skipStep(
      skipStep(
        skipStep(
          recordOutcome(initialWizardState(), "root", rootOutcome()),
          "seat",
        ),
        "grant",
      ),
      "budget",
    );
    assert.equal(canFinish(done), true);
  });
  it("an uncreated root blocks finish", () => {
    const stalled = { position: 5, outcomes: {} };
    assert.equal(canFinish(stalled), false);
  });
});
