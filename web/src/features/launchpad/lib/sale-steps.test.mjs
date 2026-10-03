import assert from "node:assert/strict";
import test from "node:test";

import { isSetupStage, nextSaleStep, saleSteps } from "./sale-steps.ts";

const record = { stage: "draft", auction: null, token: null };

test("a prepared sale is waiting on the deploy first", () => {
  const steps = saleSteps(record, 0);
  assert.deepEqual(
    steps.map((s) => [s.key, s.done]),
    [
      ["prepared", true],
      ["deploy", false],
      ["open", false],
      ["announce", false],
    ],
  );
  assert.equal(nextSaleStep(steps)?.key, "deploy");
});

test("deploy needs both the token and the auction", () => {
  assert.equal(saleSteps({ ...record, auction: "0xa" }, 0)[1].done, false);
  assert.equal(saleSteps({ ...record, token: "0xb" }, 0)[1].done, false);
  assert.equal(
    saleSteps({ ...record, auction: "0xa", token: "0xb" }, 0)[1].done,
    true,
  );
});

test("the sale is open once the launch is live or later", () => {
  for (const stage of ["live", "funding", "graduated"]) {
    assert.equal(saleSteps({ ...record, stage }, 0)[2].done, true);
  }
  for (const stage of ["draft", "review", "failed"]) {
    assert.equal(saleSteps({ ...record, stage }, 0)[2].done, false);
  }
});

test("announcing is done by the first update; all done means no next step", () => {
  const done = saleSteps({ stage: "live", auction: "0xa", token: "0xb" }, 1);
  assert.equal(nextSaleStep(done), null);
});

test("setup stages are draft and review", () => {
  assert.equal(isSetupStage("draft"), true);
  assert.equal(isSetupStage("review"), true);
  assert.equal(isSetupStage("live"), false);
  assert.equal(isSetupStage("failed"), false);
});

test("each step says where it is done", () => {
  const actions = saleSteps(record, 0).map((s) => s.action);
  assert.deepEqual(actions, [null, "manage", "manage", "update"]);
});
