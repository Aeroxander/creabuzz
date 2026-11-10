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
  quickStartProblem,
  readableSoon,
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
  const made = { id: "nebula", author: "me", goalId: "g1" };
  saveMadeProject(store, made);
  // The goal's id comes back with it: a retry after a reload sends the same goal, not a second main goal.
  assert.deepEqual(loadMadeProject(store, "me"), made);
  // One kept before the goal's id was stored with it is not carried on: its goal id is not known.
  map.set(
    "creaton.start.quick.made",
    JSON.stringify({ id: "x", author: "me" }),
  );
  assert.equal(loadMadeProject(store, "me"), null);
  saveMadeProject(store, made);
  // Another account in the same browser does not carry on someone else's project.
  assert.equal(loadMadeProject(store, "someone-else"), null);
  assert.equal(loadMadeProject(store, null), null);
  saveMadeProject(store, null);
  assert.equal(loadMadeProject(store, "me"), null);
});

test("each problem names the answer it is about, so the form can point at it", () => {
  assert.equal(quickStartProblem(draft({ name: "" })).field, "name");
  assert.equal(quickStartProblem(draft({ pitch: "Short" })).field, "pitch");
  assert.equal(quickStartProblem(draft({ goal: "" })).field, "goal");
  assert.equal(quickStartProblem(draft({ how: "" })).field, "how");
  assert.equal(quickStartProblem(draft()), null);
});

test("a new project is waited for a bounded number of times, and a read that fails is not yet", async () => {
  const pauses = [];
  const sleep = async (ms) => void pauses.push(ms);
  let calls = 0;
  const third = async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return calls === 3;
  };
  assert.equal(
    await readableSoon(third, { tries: 5, waitMs: 10, sleep }),
    true,
  );
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [10, 10]);
  // Never readable: it stops after the last try, without one more pause.
  let never = 0;
  const no = async () => {
    never += 1;
    return false;
  };
  pauses.length = 0;
  assert.equal(await readableSoon(no, { tries: 4, waitMs: 10, sleep }), false);
  assert.equal(never, 4);
  assert.equal(pauses.length, 3);
});
