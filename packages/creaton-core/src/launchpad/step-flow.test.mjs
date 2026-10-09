/**
 * The shared step reducer behind the exit, ragequit and summon flows: a failure
 * names its step, a retry asks only for what is not yet confirmed, and a plan
 * that omits a step marks it skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStepFlow } from "./step-flow.ts";

const LABELS = { send: "Send the money", mirror: "Record it" };
const flow = createStepFlow(["send", "mirror"], LABELS);

test("a fresh plan marks omitted steps skipped and the rest pending", () => {
  const state = flow.reducer(flow.initial(), { type: "reset", order: ["send"] });
  assert.deepEqual(state.steps, { send: "pending", mirror: "skipped" });
  assert.equal(state.phase, "idle");
});

test("finishing the last planned step ends the attempt; an earlier one does not", () => {
  let state = flow.reducer(flow.initial(), {
    type: "reset",
    order: ["send", "mirror"],
  });
  state = flow.reducer(state, { type: "step-start", step: "send" });
  assert.equal(state.phase, "running");
  state = flow.reducer(state, {
    type: "step-done",
    step: "send",
    receipt: { txHash: "0xabc" },
  });
  assert.equal(state.phase, "running");
  assert.deepEqual(state.receipts, { send: { txHash: "0xabc" } });
  state = flow.reducer(state, { type: "step-done", step: "mirror" });
  assert.equal(state.phase, "done");
});

test("a failure names the step and its reason, and a retry only asks for what is left", () => {
  let state = flow.reducer(flow.initial(), {
    type: "reset",
    order: ["send", "mirror"],
  });
  state = flow.reducer(state, { type: "step-done", step: "send" });
  state = flow.reducer(state, {
    type: "step-failed",
    step: "mirror",
    message: "relay refused",
  });
  assert.equal(state.phase, "failed");
  assert.equal(state.failedStep, "mirror");
  assert.equal(state.errorMessage, "Record it failed: relay refused");
  assert.deepEqual(flow.remaining(state), ["mirror"]);
  assert.deepEqual([...flow.completed(state)], ["send"]);
});

test("a receipt carried by a failure is kept, and starting again clears the error", () => {
  let state = flow.reducer(flow.initial(), { type: "reset", order: ["send"] });
  state = flow.reducer(state, {
    type: "step-failed",
    step: "send",
    message: "unknown outcome",
    receipt: { txHash: "0xdef" },
  });
  assert.deepEqual(state.receipts, { send: { txHash: "0xdef" } });
  state = flow.reducer(state, { type: "step-start", step: "send" });
  assert.equal(state.failedStep, null);
  assert.equal(state.errorMessage, null);
});
