import assert from "node:assert/strict";
import test from "node:test";

import { namedReviewers, reviewerTargets } from "./reviewer-launches.ts";

const DAO = "0x00000000000000000000000000000000000000d0";
const ALICE = "0x000000000000000000000000000000000000a11c";
const BOB = "0x0000000000000000000000000000000000000b0b";

const launch = (id, receipts, over = {}) => ({
  record: {
    id,
    author: "a".repeat(64),
    treasury: DAO,
    tokenPlan: { mode: "dao" },
    ...over,
  },
  bids: [],
  updates: [],
  proposals: [],
  receipts,
});
const receipt = (table, payload) => ({
  id: `r-${table}`,
  launchId: "x",
  launchKey: "k",
  author: "a".repeat(64),
  createdAt: 1,
  table,
  tx: "0x",
  payload,
});

test("the reviewers a launch's own receipt names are found, in lower case", () => {
  const l = launch("n", [
    receipt("dao-launch", {
      panel: { reviewers: [ALICE.toUpperCase().replace("0X", "0x"), BOB] },
    }),
  ]);
  assert.deepEqual(namedReviewers(l).sort(), [ALICE, BOB].sort());
});

test("only the launch receipt counts: a claim or a swap that mentions a panel names no reviewers", () => {
  const l = launch("n", [receipt("claim", { panel: { reviewers: [ALICE] } })]);
  assert.deepEqual(namedReviewers(l), []);
  assert.deepEqual(
    namedReviewers(launch("n", [receipt("dao-launch", { panel: "nope" })])),
    [],
  );
  assert.deepEqual(
    namedReviewers(
      launch("n", [receipt("dao-launch", { panel: { reviewers: "x" } })]),
    ),
    [],
  );
});

test("a wallet is pointed at the projects that named it, and only those", () => {
  const mine = launch("mine", [
    receipt("dao-launch", { panel: { reviewers: [ALICE] } }),
  ]);
  const other = launch("other", [
    receipt("dao-launch", { panel: { reviewers: [BOB] } }),
  ]);
  const none = launch("none", []);
  const found = reviewerTargets([mine, other, none], ALICE);
  assert.deepEqual(
    found.map((t) => [t.launch.record.id, t.dao]),
    [["mine", DAO]],
  );
  assert.deepEqual(reviewerTargets([mine], null), []);
});

test("a project the caller skips (the sandbox) is left out, and one with no DAO cannot be read", () => {
  const mine = launch("sandbox", [
    receipt("dao-launch", { panel: { reviewers: [ALICE] } }),
  ]);
  assert.deepEqual(
    reviewerTargets([mine], ALICE, (l) => l.record.id === "sandbox"),
    [],
  );
  const noDao = launch(
    "nodao",
    [receipt("dao-launch", { panel: { reviewers: [ALICE] } })],
    {
      treasury: null,
      tokenPlan: null,
    },
  );
  assert.deepEqual(reviewerTargets([noDao], ALICE), []);
});
