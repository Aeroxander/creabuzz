import assert from "node:assert/strict";
import test from "node:test";

import { auctionDeployReducer, initAuctionDeployState } from "./auctionFlow.ts";
import {
  auctionFailureMessage,
  deployStepStatusText,
  graduationStepStatusText,
  stepMarker,
} from "./auction-copy.ts";

const short = (hash) => `${hash.slice(0, 6)}…`;
const TX = `0x${"cd".repeat(32)}`;
const EXECUTOR = "0x4444444444444444444444444444444444444444";
const AUCTION = "0x5555555555555555555555555555555555555555";

// States are produced by the REAL reducer (the production seam), not built by
// hand, so a renamed field or status in the flow breaks these tests.
function run(admission, actions) {
  return actions.reduce(
    auctionDeployReducer,
    initAuctionDeployState(admission),
  );
}

test("no failure, no message", () => {
  assert.equal(
    auctionFailureMessage(initAuctionDeployState("community")),
    null,
  );
});

test("a preflight block says nothing was sent", () => {
  const state = run("community", [
    { type: "begin", mode: "fresh" },
    { type: "blocked", stage: "plan", detail: "floor price is not a number" },
  ]);
  const message = auctionFailureMessage(state);
  assert.match(message, /^Nothing was sent\./);
  assert.match(message, /floor price is not a number/);
});

test("a reverted step names the step, the tx, what already landed, and the retry", () => {
  const state = run("community", [
    { type: "begin", mode: "fresh" },
    { type: "prepared", auctionAddress: null },
    { type: "step_started", step: "executor" },
    {
      type: "step_done",
      step: "executor",
      txHash: TX,
      address: EXECUTOR,
      alreadyDeployed: false,
    },
    { type: "step_started", step: "auction" },
    {
      type: "step_failed",
      step: "auction",
      txHash: TX,
      outcome: "reverted",
      reason: "execution reverted",
    },
  ]);
  const message = auctionFailureMessage(state);
  assert.match(message, /was reverted onchain: execution reverted/);
  assert.ok(message.includes(`Transaction: ${TX}.`));
  assert.match(message, /Already done: .*Graduation executor/);
  assert.match(message, /runs again from this step/);
});

test("an unknown outcome warns it may have gone through and says how retry checks", () => {
  const state = run("community", [
    { type: "begin", mode: "fresh" },
    { type: "prepared", auctionAddress: null },
    { type: "step_started", step: "executor" },
    {
      type: "step_failed",
      step: "executor",
      txHash: null,
      outcome: "unknown",
      reason: "wallet closed",
    },
  ]);
  const message = auctionFailureMessage(state);
  assert.match(message, /may or may not have gone through/);
  assert.match(message, /first checks whether it already landed/);
  assert.match(message, /No steps were completed\./);
});

test("a link failure says the onchain work is done and names the auction", () => {
  const state = run("community", [
    { type: "begin", mode: "fresh" },
    { type: "prepared", auctionAddress: AUCTION },
    { type: "link_started" },
    { type: "link_failed", reason: "relay rejected the record" },
  ]);
  const message = auctionFailureMessage(state);
  assert.ok(message.includes(AUCTION));
  assert.match(message, /onchain work is complete/);
  assert.match(message, /Retry record update/);
});

test("step status words cover every state, and a skipped hook explains itself", () => {
  const state = run("community", [{ type: "begin", mode: "fresh" }]);
  assert.match(
    deployStepStatusText(state.steps.hook, short),
    /community track/,
  );
  assert.equal(deployStepStatusText(state.steps.executor, short), "Pending");
  const done = run("community", [
    { type: "begin", mode: "fresh" },
    { type: "prepared", auctionAddress: null },
    {
      type: "step_done",
      step: "executor",
      txHash: TX,
      address: EXECUTOR,
      alreadyDeployed: false,
    },
  ]);
  assert.equal(
    deployStepStatusText(done.steps.executor, short),
    `Confirmed ${short(TX)}`,
  );
  const already = run("community", [
    { type: "begin", mode: "resume" },
    { type: "prepared", auctionAddress: null },
    {
      type: "step_done",
      step: "executor",
      txHash: null,
      address: EXECUTOR,
      alreadyDeployed: true,
    },
  ]);
  assert.equal(
    deployStepStatusText(already.steps.executor, short),
    "Done (already deployed)",
  );
  assert.equal(graduationStepStatusText("active"), "In progress…");
  assert.equal(graduationStepStatusText("skipped"), "Not planned");
  assert.equal(graduationStepStatusText("pending"), "Pending");
});

test("markers are distinct per status so state never relies on colour", () => {
  const markers = ["running", "done", "failed", "skipped", "pending"].map(
    stepMarker,
  );
  assert.equal(new Set(markers).size, 5);
  assert.equal(stepMarker("active"), stepMarker("running"));
});
