import assert from "node:assert/strict";
import { test } from "node:test";

import { parseHelpSignal } from "./help-request.ts";
import {
  myTaskNeeds,
  needWords,
  orderNeeds,
  projectState,
  stateNeeds,
  taskNeeds,
} from "./project-state.ts";
import { parseTaskRecord } from "./tasks.ts";

const FOUNDER = "f".repeat(64);
const MATE = "a".repeat(64);
const HELPER = "b".repeat(64);
const COORD = `37001:${FOUNDER}:nebula`;
const DAY = 86_400;
const NOW = 1_800_000_000;
const team = new Set([FOUNDER, MATE]);
const ALL = { team: true, offers: true, helpers: true, posts: true };

let n = 0;
const id = () => {
  n += 1;
  return n.toString(16).padStart(64, "0");
};
const ev = (pubkey, tags, at = NOW - 100) => ({
  id: id(),
  pubkey,
  kind: 47003,
  created_at: at,
  tags: [["a", COORD], ...tags],
  content: JSON.stringify({ title: "t", body: "", note: "" }),
});
const state = (over = {}) =>
  projectState({
    coordinate: COORD,
    founder: FOUNDER,
    team,
    updates: [],
    latestAt: null,
    signals: [],
    tasks: [],
    complete: ALL,
    viewer: FOUNDER,
    now: NOW,
    ...over,
  });

test("an update is due for the founder after a week, or when none was ever posted; never for anyone else", () => {
  assert.deepEqual(state().updateDue, { days: null });
  assert.deepEqual(state({ latestAt: NOW - 9 * DAY }).updateDue, { days: 9 });
  assert.equal(state({ latestAt: NOW - 2 * DAY }).updateDue, undefined);
  assert.equal(state({ viewer: MATE }).updateDue, undefined);
  assert.equal(state({ viewer: null }).updateDue, undefined);
});

test("nothing is said to be due when the newest update may not have been read", () => {
  const cut = state({ complete: { ...ALL, team: false } });
  assert.equal(cut.updatesKnown, false);
  assert.equal(cut.updateDue, undefined);
  assert.equal(cut.promises, null);
  assert.equal(cut.openHelp, null);
  assert.equal(
    state({ complete: { ...ALL, posts: false } }).updateDue,
    undefined,
  );
});

test("promises are totalled from the founder's updates alone", () => {
  const first = {
    id: "u1".padEnd(64, "0"),
    author: FOUNDER,
    createdAt: NOW - 14 * DAY,
    weekly: true,
    promises: [
      { index: 0, text: "Ship" },
      { index: 1, text: "Write docs" },
    ],
  };
  const second = {
    id: "u2".padEnd(64, "0"),
    author: FOUNDER,
    createdAt: NOW - 7 * DAY,
    weekly: true,
    marks: [
      { promiseId: `${first.id}:0`, state: "done", note: "" },
      { promiseId: `${first.id}:1`, state: "not-done", note: "" },
    ],
  };
  const mates = { ...first, id: "u3".padEnd(64, "0"), author: MATE };
  const got = state({
    updates: [first, second, mates],
    latestAt: second.createdAt,
  });
  assert.deepEqual(got.promises, {
    kept: 1,
    missed: 1,
    changed: 0,
    unanswered: 0,
  });
});

test("offers wait for a reply until the team replies, makes a task from them, or marks help found", () => {
  const update = {
    id: id(),
    author: FOUNDER,
    createdAt: NOW - DAY,
    weekly: true,
    help: { text: "A tester", size: "small", time: "" },
  };
  const offer = (by) => parseHelpSignal(ev(by, [["help-offer", update.id]]));
  const one = offer(HELPER);
  const two = offer("c".repeat(64));
  const base = { updates: [update], latestAt: update.createdAt };
  const waiting = state({ ...base, signals: [one, two] });
  assert.equal(waiting.openHelp, 1);
  assert.deepEqual(waiting.offers, [{ updateId: update.id, count: 2 }]);
  // A reply from the team answers one of them.
  const reply = parseHelpSignal(ev(MATE, [["help-reply", one.id]]));
  assert.deepEqual(state({ ...base, signals: [one, two, reply] }).offers, [
    { updateId: update.id, count: 1 },
  ]);
  // "Help found" closes the request: nothing waits.
  const found = parseHelpSignal(ev(FOUNDER, [["help-found", update.id]]));
  const closed = state({ ...base, signals: [one, two, found] });
  assert.equal(closed.openHelp, 0);
  assert.deepEqual(closed.offers, []);
  // Someone who is not on the team is told nothing about replies owed.
  assert.deepEqual(
    state({ ...base, signals: [one], viewer: HELPER }).offers,
    [],
  );
  // The offers read was cut: how many wait is not known, so none is claimed.
  assert.deepEqual(
    state({ ...base, signals: [one], complete: { ...ALL, offers: false } })
      .offers,
    [],
  );
});

function taskWith(steps, helper = HELPER, due = null) {
  const task = ev(FOUNDER, [
    ["l", "creaton-task"],
    ["task-part", "task"],
    ["task-helper", helper],
    ["task-what", "Test sign-up"],
    ["task-done", "A recording"],
    ["task-size", "small"],
    ...(due ? [["task-due", due]] : []),
  ]);
  const made = steps.map(([by, part, extra = []]) =>
    ev(by, [
      ["l", "creaton-task"],
      ["task-part", part],
      ["task", task.id],
      ["e", task.id],
      ...extra,
    ]),
  );
  return [task, ...made].map((e) => parseTaskRecord(e));
}

test("handed-in work waits for a check by a team member who did not do it", () => {
  const records = taskWith([
    [HELPER, "accept"],
    [HELPER, "evidence", [["task-link", "https://example.org/r"]]],
  ]);
  assert.equal(state({ tasks: records }).checks.length, 1);
  assert.equal(state({ tasks: records, viewer: HELPER }).checks.length, 0);
  // The founder's own work is not theirs to check.
  const own = taskWith(
    [[FOUNDER, "evidence", [["task-link", "https://example.org/r"]]]],
    FOUNDER,
  );
  assert.equal(state({ tasks: own }).checks.length, 0);
  assert.equal(state({ tasks: own, viewer: MATE }).checks.length, 1);
  // Not all of the task records were read: nothing is said to be waiting.
  assert.equal(
    state({ tasks: records, complete: { ...ALL, helpers: false } }).checks
      .length,
    0,
  );
});

test("a person's own tasks: waiting for their yes, and due soon or late once they said yes", () => {
  const soon = new Date((NOW + 2 * DAY) * 1000).toISOString().slice(0, 10);
  const far = new Date((NOW + 30 * DAY) * 1000).toISOString().slice(0, 10);
  const past = new Date((NOW - 2 * DAY) * 1000).toISOString().slice(0, 10);
  const views = (records) => state({ tasks: records }).tasks;
  const offered = views(taskWith([]));
  assert.equal(myTaskNeeds(offered, HELPER, NOW).forYes.length, 1);
  assert.equal(myTaskNeeds(offered, MATE, NOW).forYes.length, 0);
  const due = (date) =>
    myTaskNeeds(
      views(taskWith([[HELPER, "accept"]], HELPER, date)),
      HELPER,
      NOW,
    ).dueSoon;
  assert.equal(due(soon).length, 1);
  assert.equal(due(soon)[0].late, false);
  assert.equal(due(far).length, 0);
  assert.equal(due(past)[0].late, true);
  assert.equal(due(null).length, 0);
});

test("needs are met in order: what others wait on first, late before soon, and each says one action", () => {
  const needs = orderNeeds([
    { kind: "update-due", coordinate: COORD, days: 9 },
    {
      kind: "task-due",
      coordinate: COORD,
      taskId: "t2",
      what: "B",
      due: "2030-01-02",
      late: false,
    },
    {
      kind: "task-due",
      coordinate: COORD,
      taskId: "t1",
      what: "A",
      due: "2030-01-01",
      late: true,
    },
    { kind: "invitation", coordinate: COORD },
    { kind: "task-yes", coordinate: COORD, taskId: "t3", what: "C" },
    { kind: "offers", coordinate: COORD, updateId: "u1", count: 2 },
    { kind: "check", coordinate: COORD, taskId: "t4", what: "D" },
  ]);
  assert.deepEqual(
    needs.map((need) => need.kind),
    [
      "check",
      "offers",
      "task-yes",
      "invitation",
      "task-due",
      "task-due",
      "update-due",
    ],
  );
  assert.equal(needs[4].late, true);
  for (const need of needs) {
    const words = needWords(need, "Nebula");
    assert.ok(words.text.includes("Nebula"));
    assert.ok(words.action.length > 0);
    assert.doesNotMatch(`${words.text} ${words.action}`, /earn|\$|Shares/i);
  }
  assert.equal(
    needWords(
      { kind: "offers", coordinate: COORD, updateId: "u", count: 1 },
      "Nebula",
    ).text,
    "An offer to help with Nebula is waiting for your reply.",
  );
});

test("a state's needs and a person's task needs are what the page lists", () => {
  const records = taskWith([
    [HELPER, "accept"],
    [HELPER, "evidence", [["task-link", "https://example.org/r"]]],
  ]);
  const got = state({ tasks: records });
  assert.deepEqual(
    stateNeeds(got).map((need) => need.kind),
    ["check", "update-due"],
  );
  const offered = state({ tasks: taskWith([]) }).tasks;
  assert.deepEqual(
    taskNeeds(offered, HELPER, NOW).map((need) => need.kind),
    ["task-yes"],
  );
});
