import assert from "node:assert/strict";
import test from "node:test";

import {
  allGoals,
  goalEvent,
  goalIssue,
  goalRecordEntries,
  goalSignedAt,
  goalTotals,
  goalTotalsLine,
  isGoalRecordTags,
  newGoalId,
  parseGoalVersion,
  projectGoals,
} from "./goals.ts";

const FOUNDER = "f".repeat(64);
const OTHER = "e".repeat(64);

let seq = 0;
/** A goal record as the app publishes it, signed by `pubkey` at `at`. */
function record(input, at, pubkey = FOUNDER) {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    tags: [["a", `37001:${FOUNDER}:nebula`], ...goalEvent(input).tags],
  };
}
const goal = (over = {}) => ({
  id: "g1",
  level: "primary",
  text: "Ship the first version",
  how: "Ten people use it in one week",
  state: "open",
  reason: "",
  ...over,
});
const read = (events) =>
  projectGoals(
    events.flatMap((e) => {
      const v = parseGoalVersion(e);
      return v ? [v] : [];
    }),
    FOUNDER,
  );

test("a goal record carries the goal as structured tags and as readable words", () => {
  const { content, tags } = goalEvent(goal());
  assert.deepEqual(tags, [
    ["goal", "g1"],
    ["goal-level", "primary"],
    ["goal-text", "Ship the first version"],
    ["goal-how", "Ten people use it in one week"],
    ["goal-state", "open"],
  ]);
  assert.equal(content.title, "Goal");
  assert.equal(
    content.body,
    "Ship the first version\nHow we'll know: Ten people use it in one week",
  );
  assert.equal(isGoalRecordTags(tags), true);
  assert.equal(isGoalRecordTags([["update-part", "done", "x"]]), false);
});

test("a shorter goal names the main goal it sits under, and a missed one says why", () => {
  const { content, tags } = goalEvent(
    goal({
      id: "g2",
      level: "week",
      text: "Fix sign-up",
      how: "A new person gets in",
      state: "missed",
      reason: "The email provider was down",
      under: "g1",
    }),
  );
  assert.deepEqual(tags.slice(-2), [
    ["goal-reason", "The email provider was down"],
    ["goal-under", "g1"],
  ]);
  assert.equal(content.title, "Goal missed");
  assert.match(content.body, /^This week: Fix sign-up\n/);
  assert.match(content.body, /Why: The email provider was down$/);
});

test("a record that is not a whole goal is not read as one", () => {
  const base = record(goal(), 100);
  const without = (name) => ({
    ...base,
    tags: base.tags.filter((t) => t[0] !== name),
  });
  assert.equal(parseGoalVersion(without("goal")), null);
  assert.equal(parseGoalVersion(without("goal-text")), null);
  assert.equal(parseGoalVersion(without("goal-level")), null);
  assert.equal(parseGoalVersion(without("goal-state")), null);
  const badState = {
    ...base,
    tags: base.tags.map((t) =>
      t[0] === "goal-state" ? ["goal-state", "deleted"] : t,
    ),
  };
  assert.equal(parseGoalVersion(badState), null);
  assert.equal(parseGoalVersion(base).text, "Ship the first version");
});

test("only the founder's goal records count", () => {
  const goals = read([
    record(goal(), 100),
    record(goal({ state: "reached" }), 200, OTHER),
    record(goal({ id: "g9", text: "Someone else's goal" }), 300, OTHER),
  ]);
  assert.equal(goals.primary.state, "open");
  assert.equal(allGoals(goals).length, 1);
});

test("the newest record is how the goal stands, and the older ones are its history", () => {
  const goals = read([
    record(goal({ state: "missed", reason: "Ran out of time" }), 300),
    record(goal(), 100),
  ]);
  const primary = goals.primary;
  assert.equal(primary.state, "missed");
  assert.equal(primary.reason, "Ran out of time");
  assert.equal(primary.setAt, 100);
  assert.deepEqual(
    primary.history.map((h) => [h.step, h.at]),
    [
      ["set", 100],
      ["missed", 300],
    ],
  );
});

test("a reworded goal keeps what it was", () => {
  const goals = read([
    record(goal(), 100),
    record(
      goal({
        text: "Ship a smaller first version",
        reason: "The first plan was too big",
      }),
      200,
    ),
  ]);
  const primary = goals.primary;
  assert.equal(primary.text, "Ship a smaller first version");
  assert.equal(primary.state, "open");
  const changed = primary.history[1];
  assert.equal(changed.step, "changed");
  assert.deepEqual(changed.was, {
    text: "Ship the first version",
    how: "Ten people use it in one week",
  });
  assert.equal(changed.reason, "The first plan was too big");
});

test("a goal marked missed and then something else is still a goal that was missed", () => {
  const goals = read([
    record(goal(), 100),
    record(goal({ state: "missed", reason: "Late" }), 200),
    record(goal({ state: "open" }), 300),
    record(goal({ state: "reached" }), 400),
  ]);
  assert.equal(goals.primary.state, "reached");
  assert.deepEqual(
    goals.primary.history.map((h) => h.step),
    ["set", "missed", "reopened", "reached"],
  );
  const totals = goalTotals(allGoals(goals));
  assert.deepEqual(totals, { reached: 1, missed: 1, changed: 0 });
  assert.equal(goalTotalsLine(totals), "1 goal reached, 1 missed, 0 changed");
  // The miss is on the record with its reason and date, newest first.
  assert.deepEqual(
    goalRecordEntries(allGoals(goals)).map((e) => [e.step, e.at, e.reason]),
    [
      ["reached", 400, ""],
      ["missed", 200, "Late"],
    ],
  );
});

test("the same goal sent twice is one step, not two", () => {
  const goals = read([record(goal(), 100), record(goal(), 101)]);
  assert.equal(goals.primary.history.length, 1);
});

test("the newest main goal leads; earlier ones and closed shorter goals stay listed", () => {
  const goals = read([
    record(goal({ id: "old" }), 100),
    record(goal({ id: "old", state: "changed", reason: "New direction" }), 200),
    record(goal({ id: "new", text: "Reach a hundred readers" }), 300),
    record(goal({ id: "w1", level: "week", text: "Write the intro" }), 310),
    record(goal({ id: "q1", level: "quarter", text: "Launch the site" }), 320),
    record(goal({ id: "m1", level: "month", text: "Old month goal" }), 150),
    record(
      goal({
        id: "m1",
        level: "month",
        text: "Old month goal",
        state: "reached",
      }),
      250,
    ),
  ]);
  assert.equal(goals.primary.id, "new");
  assert.deepEqual(
    goals.shorter.map((g) => g.id),
    ["q1", "w1"],
  );
  assert.deepEqual(
    goals.earlier.map((g) => [g.id, g.state]),
    [
      ["m1", "reached"],
      ["old", "changed"],
    ],
  );
  assert.equal(goalTotalsLine(goalTotals([])), null);
});

test("no goal records, no goal", () => {
  assert.deepEqual(read([]), { primary: null, shorter: [], earlier: [] });
});

test("a goal needs its words, how we'll know, and a reason when missed, changed or reworded", () => {
  assert.equal(goalIssue(goal()), null);
  assert.equal(goalIssue(goal({ text: " " })), "Say what the goal is.");
  assert.equal(
    goalIssue(goal({ how: "" })),
    "Say how we'll know it was reached.",
  );
  assert.equal(
    goalIssue(goal({ state: "missed" })),
    "Say in one line why it was missed.",
  );
  assert.equal(goalIssue(goal({ state: "missed", reason: "Late" })), null);
  assert.equal(
    goalIssue(goal({ state: "changed" })),
    "Say in one line why it changed.",
  );
  const before = {
    text: "An older goal",
    how: "Ten people use it in one week",
  };
  assert.equal(goalIssue(goal(), before), "Say in one line why it changed.");
  assert.equal(goalIssue(goal({ reason: "Narrower" }), before), null);
  // Reaching it needs no reason.
  assert.equal(goalIssue(goal({ state: "reached" }), goal()), null);
});

test("a new goal id is short and safe to put in a tag", () => {
  const id = newGoalId(() => 0.5);
  assert.match(id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(parseGoalVersion(record(goal({ id }), 1)).id, id);
});

test("a goal changed twice in one second: the second change is signed later, so it is the goal as it stands", () => {
  // The clock is later than the version being replaced: the record is signed now.
  assert.equal(goalSignedAt(1_000, 990), undefined);
  // A new goal replaces nothing.
  assert.equal(goalSignedAt(1_000, undefined), undefined);
  // The same second, or a clock that runs behind the device that saved the last version: one second after it.
  assert.equal(goalSignedAt(1_000, 1_000), 1_001);
  assert.equal(goalSignedAt(1_000, 1_030), 1_031);

  // Why it matters: two versions signed in the same second are ordered by their ids, which is a coin toss. Here the
  // reworded goal has the smaller id and loses; signed when goalSignedAt says, it is the goal whatever its id.
  const missed = {
    ...record(goal({ state: "missed", reason: "Too slow" }), 1_000),
    id: "b".repeat(64),
  };
  const reworded = (at) => ({
    ...record(
      goal({
        text: "A first version five people use",
        reason: "Ten was too many",
      }),
      at,
    ),
    id: "a".repeat(64),
  });
  const tied = projectGoals(
    [missed, reworded(1_000)].map(parseGoalVersion).filter(Boolean),
    FOUNDER,
  );
  assert.equal(tied.primary.text, goal().text, "tied: the older words win");
  const ordered = projectGoals(
    [missed, reworded(goalSignedAt(1_000, 1_000))]
      .map(parseGoalVersion)
      .filter(Boolean),
    FOUNDER,
  );
  assert.equal(ordered.primary.text, "A first version five people use");
  assert.equal(ordered.primary.state, "open");
});
