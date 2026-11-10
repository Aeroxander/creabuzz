import assert from "node:assert/strict";
import { test } from "node:test";

import { goalEvent } from "../../launchpad/lib/goals.ts";
import { ideaToInput } from "../../launchpad/lib/idea.ts";
import {
  EMPTY_QUICK_START,
  loadMadeProject,
  loadQuickStart,
  quickStartGoal,
  quickStartIssue,
  saveMadeProject,
  saveQuickStart,
} from "./quick-start.ts";

const draft = (over = {}) => ({
  name: "Nebula",
  pitch: "A map of the night sky for everyone.",
  goal: "A first version ten people use",
  how: "Ten people sign in during one week",
  ...over,
});

test("four answers are enough, and each missing one is named in the form's order", () => {
  assert.equal(quickStartIssue(draft()), null);
  assert.equal(
    quickStartIssue(draft({ name: "" })),
    "Give your project a name.",
  );
  assert.equal(
    quickStartIssue(draft({ pitch: "Short" })),
    "Say what it is in a sentence.",
  );
  assert.equal(quickStartIssue(draft({ goal: "" })), "Say what the goal is.");
  assert.equal(
    quickStartIssue(draft({ how: " " })),
    "Say how we'll know it was reached.",
  );
});

test("the project made has no Shares, no money, no network and no rooms to wait for", () => {
  const input = ideaToInput({
    id: "nebula",
    ...draft(),
    chat: { team: null, supporters: null, backers: null, board: null },
  });
  assert.equal(input.stage, "draft");
  for (const field of ["chainId", "token", "treasury", "auction", "currency"])
    assert.equal(input[field], "", field);
  assert.deepEqual(input.channels, []);
});

test("the first goal is the project's main goal, open, as structured tags", () => {
  const { tags } = goalEvent(quickStartGoal(draft(), "g1"));
  assert.deepEqual(tags, [
    ["goal", "g1"],
    ["goal-level", "primary"],
    ["goal-text", "A first version ten people use"],
    ["goal-how", "Ten people sign in during one week"],
    ["goal-state", "open"],
  ]);
});

test("what was typed survives the visit, and is forgotten once the project is made", () => {
  const map = new Map();
  const store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  assert.deepEqual(loadQuickStart(store), EMPTY_QUICK_START);
  saveQuickStart(store, draft());
  assert.deepEqual(loadQuickStart(store), draft());
  saveQuickStart(store, null);
  assert.deepEqual(loadQuickStart(store), EMPTY_QUICK_START);
  // Storage that refuses, or holds something else, is an empty form.
  map.set("creaton.start.quick", "{not json");
  assert.deepEqual(loadQuickStart(store), EMPTY_QUICK_START);
  assert.deepEqual(loadQuickStart(null), EMPTY_QUICK_START);
});

test("a project made whose goal is still to be saved is remembered for its founder only", () => {
  const map = new Map();
  const store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  assert.equal(loadMadeProject(store, "me"), null);
  saveMadeProject(store, { id: "nebula", author: "me" });
  assert.deepEqual(loadMadeProject(store, "me"), {
    id: "nebula",
    author: "me",
  });
  // Another account in the same browser does not carry on someone else's project.
  assert.equal(loadMadeProject(store, "someone-else"), null);
  assert.equal(loadMadeProject(store, null), null);
  saveMadeProject(store, null);
  assert.equal(loadMadeProject(store, "me"), null);
});
