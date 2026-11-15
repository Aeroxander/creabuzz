import assert from "node:assert/strict";
import { test } from "node:test";

import { goalEvent } from "../../launchpad/lib/goals.ts";
import { ideaToInput } from "../../launchpad/lib/idea.ts";
import {
  applySuggestion,
  clearStartAfterSignUp,
  EMPTY_QUICK_START,
  HOW_EXAMPLES,
  loadMadeProject,
  loadStartAttempt,
  projectToStart,
  saveStartAttempt,
  loadQuickStart,
  quickStartGoal,
  markStartAfterSignUp,
  quickStartIssue,
  quickStartPitch,
  quickStartProblem,
  readableSoon,
  saveMadeProject,
  saveQuickStart,
  startAfterSignUpWaiting,
  takeStartAfterSignUp,
} from "./quick-start.ts";

// The one-liner is not asked: it comes from the goal unless the founder edits it, so `pitch` is empty here.
const draft = (over = {}) => ({
  name: "Nebula",
  pitch: "",
  goal: "A first version ten people use",
  how: "Ten people sign in during one week",
  category: "",
  kind: "",
  ...over,
});

test("three answers are enough, and each missing one is named in the form's order", () => {
  assert.equal(quickStartIssue(draft()), null);
  assert.equal(
    quickStartIssue(draft({ name: "" })),
    "Give your project a name.",
  );
  // No one-liner was written, so a goal too short to be one is a problem with the goal, not with a box nobody saw.
  assert.equal(
    quickStartIssue(draft({ goal: "Ship it" })),
    "Say the goal in a sentence.",
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
    pitch: quickStartPitch(draft()),
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
  // One kept before the goal's id was stored with it is still carried on (dropping it would make a second project):
  // it is given a goal id, and keeps that one from then on.
  map.set(
    "creaton.start.quick.made",
    JSON.stringify({ id: "x", author: "me" }),
  );
  let minted = 0;
  const mint = () => {
    minted += 1;
    return `minted${minted}`;
  };
  assert.deepEqual(loadMadeProject(store, "me", mint), {
    id: "x",
    author: "me",
    goalId: "minted1",
  });
  assert.equal(loadMadeProject(store, "me", mint).goalId, "minted1");
  saveMadeProject(store, made);
  // Another account in the same browser does not carry on someone else's project.
  assert.equal(loadMadeProject(store, "someone-else"), null);
  assert.equal(loadMadeProject(store, null), null);
  saveMadeProject(store, null);
  assert.equal(loadMadeProject(store, "me"), null);
});

test("each problem names the answer it is about, so the form can point at it", () => {
  assert.equal(quickStartProblem(draft({ name: "" })).field, "name");
  // An edited one-liner that is too short is pointed at in its own box, which is open because it was edited.
  assert.equal(quickStartProblem(draft({ pitch: "Short" })).field, "pitch");
  assert.equal(quickStartProblem(draft({ goal: "Ship it" })).field, "goal");
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

test("a press whose publish landed but whose answer was lost is carried on, not made again under another id", async () => {
  const fresh = (taken) =>
    taken.includes("nebula") ? "nebula-ab12" : "nebula";
  const attempt = { id: "nebula", author: "me" };
  // The earlier press landed: the record is there. Carry on with it; do not see its id as taken and suffix.
  assert.deepEqual(
    await projectToStart({
      attempt,
      hasOwn: async (id) => id === "nebula",
      fresh,
      mine: ["nebula"],
    }),
    { id: "nebula", adopt: true },
  );
  // The earlier press did not land: publish, under the same id again.
  assert.deepEqual(
    await projectToStart({
      attempt,
      hasOwn: async () => false,
      fresh,
      mine: [],
    }),
    { id: "nebula", adopt: false },
  );
  // No earlier press, and the person already has a project by that id (an older one of theirs): a new id.
  assert.deepEqual(
    await projectToStart({
      attempt: null,
      hasOwn: async () => false,
      fresh,
      mine: ["nebula"],
    }),
    { id: "nebula-ab12", adopt: false },
  );
  // No earlier press, the list did not hold it, but the server has it under that id: still never replaced.
  assert.deepEqual(
    await projectToStart({
      attempt: null,
      hasOwn: async (id) => id === "nebula",
      fresh,
      mine: [],
    }),
    { id: "nebula-ab12", adopt: false },
  );
  // If the server cannot be asked, nothing is decided: the press fails and nothing is made.
  await assert.rejects(
    projectToStart({
      attempt,
      hasOwn: async () => {
        throw new Error("offline");
      },
      fresh,
      mine: [],
    }),
    /offline/,
  );
});

test("the id a press is about to publish under is kept for its own account only", () => {
  const map = new Map();
  const store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  assert.equal(loadStartAttempt(store, "me"), null);
  saveStartAttempt(store, { id: "nebula", author: "me" });
  assert.deepEqual(loadStartAttempt(store, "me"), {
    id: "nebula",
    author: "me",
  });
  assert.equal(loadStartAttempt(store, "someone-else"), null);
  saveStartAttempt(store, null);
  assert.equal(loadStartAttempt(store, "me"), null);
});

test("the one-liner is the goal's first 140 characters until the founder writes their own", () => {
  assert.equal(quickStartPitch(draft()), "A first version ten people use");
  const long = `${"word ".repeat(60)}end`;
  const cut = quickStartPitch(draft({ goal: long }));
  assert.ok(cut.length <= 140);
  assert.equal(cut, long.trim().slice(0, 140).trim());
  // Their own words win, trimmed, and an emptied box goes back to the goal.
  assert.equal(
    quickStartPitch(draft({ pitch: "  A map of the night sky.  " })),
    "A map of the night sky.",
  );
  assert.equal(
    quickStartPitch(draft({ pitch: "   " })),
    "A first version ten people use",
  );
  // A goal of 200 characters still makes a valid project: the one-liner is cut, not refused.
  assert.equal(
    quickStartIssue(draft({ goal: "g".repeat(10) + "x".repeat(190) })),
    null,
  );
});

test("what was typed, its category and its kind survive the visit; an old draft without them loads", () => {
  const map = new Map();
  const store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  const chosen = draft({ category: "AI agent or tool", kind: "ai-media" });
  saveQuickStart(store, chosen);
  assert.deepEqual(loadQuickStart(store), chosen);
  // A draft saved before categories existed (a name, a one-liner, a goal and how; no category or kind) loads as one with none.
  map.set(
    "creaton.start.quick",
    JSON.stringify({ name: "Old", pitch: "p", goal: "g", how: "h" }),
  );
  assert.deepEqual(loadQuickStart(store), {
    name: "Old",
    pitch: "p",
    goal: "g",
    how: "h",
    category: "",
    kind: "",
  });
  // A category outside the fixed set is dropped rather than published.
  map.set(
    "creaton.start.quick",
    JSON.stringify({ ...chosen, category: "Crypto" }),
  );
  assert.equal(loadQuickStart(store).category, "");
});

test("the three examples for how we'll know are a number by a date, a link, and a named person", () => {
  assert.deepEqual(
    HOW_EXAMPLES.map((example) => example.label),
    ["A number by a date", "A link people can open", "A named person confirms"],
  );
  assert.match(HOW_EXAMPLES[0].text, /\d/);
  for (const example of HOW_EXAMPLES) assert.ok(example.text.length <= 200);
});

test("tapping a suggestion fills an empty box, replaces another suggestion, and never throws away typed words", () => {
  const known = HOW_EXAMPLES.map((example) => example.text);
  const [first, second] = known;
  assert.equal(applySuggestion("", first, known, 200), first);
  assert.equal(applySuggestion("  ", first, known, 200), first);
  // A second tap on another chip swaps the example instead of stacking two.
  assert.equal(applySuggestion(first, second, known, 200), second);
  // The founder's own words are kept, with the example under them.
  assert.equal(
    applySuggestion("Ten people sign in", second, known, 200),
    `Ten people sign in\n${second}`,
  );
  // Never past the box's own limit.
  assert.equal(
    applySuggestion("x".repeat(190), second, known, 200).length,
    200,
  );
});

test("a press waiting for an account is used up once, goes stale, and is taken back when the form changes", () => {
  const map = new Map();
  const store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  assert.equal(startAfterSignUpWaiting(store, 1_000), false);
  assert.equal(takeStartAfterSignUp(store, 1_000), false);
  markStartAfterSignUp(store, 1_000);
  assert.equal(startAfterSignUpWaiting(store, 2_000), true);
  // Asking is not using it up; taking is, and the second take (a re-render, a second announcement) is false.
  assert.equal(startAfterSignUpWaiting(store, 2_000), true);
  assert.equal(takeStartAfterSignUp(store, 2_000), true);
  assert.equal(takeStartAfterSignUp(store, 2_000), false);
  assert.equal(startAfterSignUpWaiting(store, 2_000), false);
  // A press made long ago, abandoned at the sign-up dialog, does not start a project on a later sign-up.
  markStartAfterSignUp(store, 1_000);
  assert.equal(takeStartAfterSignUp(store, 1_000 + 16 * 60_000), false);
  assert.equal(startAfterSignUpWaiting(store, 1_000 + 16 * 60_000), false);
  // Changing the form takes the press back.
  markStartAfterSignUp(store, 1_000);
  clearStartAfterSignUp(store);
  assert.equal(takeStartAfterSignUp(store, 2_000), false);
  // Storage that refuses means no automatic start, never a crash.
  const refusing = {
    getItem() {
      throw new Error("no");
    },
    setItem() {
      throw new Error("no");
    },
    removeItem() {
      throw new Error("no");
    },
  };
  markStartAfterSignUp(refusing);
  assert.equal(takeStartAfterSignUp(refusing), false);
  assert.equal(takeStartAfterSignUp(null), false);
});
