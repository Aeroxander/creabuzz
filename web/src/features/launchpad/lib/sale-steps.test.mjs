import assert from "node:assert/strict";
import test from "node:test";

import { isSetupStage, nextSaleStep, saleSteps } from "./sale-steps.ts";

const committed = {
  longPitch: "A real story",
  channels: ["room"],
  budget: "1",
  updateCadence: "weekly",
};
const record = {
  stage: "draft",
  auction: null,
  token: null,
  longPitch: null,
  channels: [],
  budget: null,
  updateCadence: null,
};

test("a prepared sale is waiting on the deploy first", () => {
  const steps = saleSteps(record, 0);
  assert.deepEqual(
    steps.map((s) => [s.key, s.done]),
    [
      ["prepared", true],
      ["commitments", false],
      ["deploy", false],
      ["open", false],
      ["announce", false],
    ],
  );
  assert.equal(nextSaleStep(steps)?.key, "commitments");
});

test("commitments are done once the record carries all of them", () => {
  assert.equal(saleSteps(record, 0)[1].done, false);
  assert.equal(saleSteps({ ...record, ...committed }, 0)[1].done, true);
  assert.equal(
    saleSteps({ ...record, ...committed, budget: null }, 0)[1].done,
    false,
  );
  const next = nextSaleStep(saleSteps({ ...record, ...committed }, 0));
  assert.equal(next?.key, "deploy");
});

test("deploy needs both the token and the auction", () => {
  assert.equal(saleSteps({ ...record, auction: "0xa" }, 0)[2].done, false);
  assert.equal(saleSteps({ ...record, token: "0xb" }, 0)[2].done, false);
  assert.equal(
    saleSteps({ ...record, auction: "0xa", token: "0xb" }, 0)[2].done,
    true,
  );
});

test("the sale is open once the launch is live or later", () => {
  for (const stage of ["live", "funding", "graduated"]) {
    assert.equal(saleSteps({ ...record, stage }, 0)[3].done, true);
  }
  for (const stage of ["draft", "review", "failed"]) {
    assert.equal(saleSteps({ ...record, stage }, 0)[3].done, false);
  }
});

test("announcing is done by the first update; all done means no next step", () => {
  const done = saleSteps(
    { ...committed, stage: "live", auction: "0xa", token: "0xb" },
    1,
  );
  assert.equal(nextSaleStep(done), null);
});

test("the walk-through runs from draft until the sale has been live", () => {
  assert.equal(isSetupStage("draft"), true);
  assert.equal(isSetupStage("review"), true);
  assert.equal(isSetupStage("live"), true);
  assert.equal(isSetupStage("funding"), false);
  assert.equal(isSetupStage("failed"), false);
});

test("each step says where it is done", () => {
  const actions = saleSteps(record, 0).map((s) => s.action);
  assert.deepEqual(actions, [null, "commitments", "manage", "live", "update"]);
});
