import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_CHOICES,
  CADENCES,
  commitmentFields,
  commitmentIssue,
} from "./commitments.ts";
import { hasFounderCommitments } from "../models.ts";

const story =
  "We are building an open tool that maps the night sky for everyone.";
const good = { longPitch: story, cadence: CADENCES[0].value, budgetShare: 10 };

test("a story, a cadence and a budget are all required", () => {
  assert.equal(commitmentIssue(good), null);
  assert.match(
    commitmentIssue({ ...good, longPitch: "too short" }),
    /at least 40/,
  );
  assert.match(commitmentIssue({ ...good, cadence: "" }), /how often/);
  assert.match(commitmentIssue({ ...good, budgetShare: 7 }), /monthly budget/);
});

test("every offered choice is valid", () => {
  for (const cadence of CADENCES) {
    for (const budgetShare of BUDGET_CHOICES) {
      assert.equal(
        commitmentIssue({ ...good, cadence: cadence.value, budgetShare }),
        null,
      );
    }
  }
});

test("the budget is a share of the raise target, in base units", () => {
  const fields = commitmentFields({ ...good, budgetShare: 10 }, "300000000000");
  assert.equal(fields.budget, "30000000000");
  assert.equal(fields.updateCadence, "weekly");
  assert.equal(fields.longPitch, story);
});

test("saved commitments satisfy the go-live rule (with a bound room)", () => {
  const fields = commitmentFields(good, "300000000000");
  assert.equal(hasFounderCommitments({ ...fields, channels: ["room"] }), true);
  assert.equal(hasFounderCommitments({ ...fields, channels: [] }), false);
});
