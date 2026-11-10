import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTaskRecord } from "../../launchpad/lib/tasks.ts";
import {
  answersLine,
  confirmedTaskIds,
  feedItems,
  itemLabel,
} from "./record-feed.ts";

const FOUNDER = "f".repeat(64);
const MATE = "a".repeat(64);
const HELPER = "b".repeat(64);
const STRANGER = "c".repeat(64);
const COORD = `37001:${FOUNDER}:nebula`;
const NOW = 2_000_000;
const INVITED = "d".repeat(64);
const GONE = "e".repeat(64);
const LEFT_AT = NOW - 1_000;
const projects = new Map([
  [
    COORD,
    {
      coordinate: COORD,
      founder: FOUNDER,
      // Who the server lets act: the founder, a member who said yes, and one who was added and has not answered.
      team: new Set([FOUNDER, MATE, INVITED]),
      // Who speaks for the project: not the one who has not said yes; a former member only until they left.
      voices: new Map([
        [FOUNDER, null],
        [MATE, null],
        [GONE, LEFT_AT],
      ]),
    },
  ],
]);

let n = 0;
const ev = (
  pubkey,
  tags,
  at = NOW - 100,
  content = { title: "T", body: "B" },
) => {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    kind: 47003,
    created_at: at,
    tags: [["a", COORD], ...tags],
    content: JSON.stringify(content),
    sig: "s",
  };
};
const items = (events, taskRecords = []) =>
  feedItems({ events, projects, taskRecords, now: NOW });

test("an update counts only from the project's team; a stranger's is not an item", () => {
  const team = ev(MATE, [["update-kind", "weekly"]]);
  const fake = ev(STRANGER, [["update-kind", "weekly"]]);
  const out = items([team, fake]);
  assert.deepEqual(
    out.map((i) => i.id),
    [team.id],
  );
  assert.equal(itemLabel(out[0]), "Update");
});

test("someone added who has not said yes is not the project's voice, though the server lets them post", () => {
  const theirs = ev(INVITED, [["update-kind", "weekly"]]);
  assert.deepEqual(items([theirs]), []);
});

test("a former member's updates from before they left stay; anything signed after is not the project's", () => {
  const before = ev(GONE, [["update-kind", "weekly"]], LEFT_AT - 10);
  const onTheDay = ev(GONE, [["update-kind", "weekly"]], LEFT_AT);
  const after = ev(GONE, [["update-kind", "weekly"]], LEFT_AT + 1);
  assert.deepEqual(
    items([before, onTheDay, after]).map((i) => i.id),
    [onTheDay.id, before.id],
  );
});

test("promises and the answers to them count only in the founder's own update", () => {
  const promiseId = `${"9".repeat(64)}:0`;
  const tags = [
    ["update-part", "next", "Ship it"],
    ["promise", "0", "Ship it"],
    ["promise-mark", promiseId, "done", ""],
    ["promise-mark", `${"9".repeat(64)}:1`, "not-done", "ran out of time"],
  ];
  const [mine] = items([ev(FOUNDER, tags)]);
  assert.deepEqual(mine.answers, { kept: 1, missed: 1, changed: 0 });
  assert.deepEqual(mine.promises, ["Ship it"]);
  assert.equal(answersLine(mine.answers), "Promises: 1 kept, 1 missed");
  const [mates] = items([ev(MATE, tags)]);
  assert.deepEqual(mates.answers, { kept: 0, missed: 0, changed: 0 });
  assert.deepEqual(mates.promises, []);
  assert.equal(answersLine(mates.answers), null);
});

test("a goal is an item once the founder marks it reached, missed or changed, and never from anyone else", () => {
  const goal = (by, state) =>
    ev(by, [
      ["goal", "g1abcdef"],
      ["goal-level", "primary"],
      ["goal-text", "Ten users"],
      ["goal-how", "Ten sign in"],
      ["goal-state", state],
      ["goal-reason", state === "missed" ? "Too few came" : ""],
    ]);
  const open = goal(FOUNDER, "open");
  const missed = goal(FOUNDER, "missed");
  const forged = goal(MATE, "reached");
  const out = items([open, missed, forged]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "goal");
  assert.equal(out[0].state, "missed");
  assert.equal(out[0].reason, "Too few came");
  assert.equal(itemLabel(out[0]), "Goal missed");
});

test("an update that asks for help is a help-wanted item", () => {
  const [item] = items([
    ev(FOUNDER, [
      ["help-needed", "A tester"],
      ["help-size", "small"],
    ]),
  ]);
  assert.equal(itemLabel(item), "Help wanted");
  assert.equal(item.help.text, "A tester");
});

test("offers, replies, team answers and task steps are not news", () => {
  const out = items([
    ev(HELPER, [["help-offer", "x".repeat(64)]]),
    ev(MATE, [["help-reply", "x".repeat(64)]]),
    ev(MATE, [
      ["team-answer", "yes"],
      ["l", "creaton-team"],
    ]),
    ev(FOUNDER, [
      ["task-part", "task"],
      ["l", "creaton-task"],
    ]),
  ]);
  assert.deepEqual(out, []);
});

/** A task made by the founder for the helper, handed in, and confirmed by `confirmer`. */
function acceptedWork(confirmer) {
  const task = ev(FOUNDER, [
    ["l", "creaton-task"],
    ["task-part", "task"],
    ["task-helper", HELPER],
    ["task-what", "Test sign-up"],
    ["task-done", "A recording"],
    ["task-size", "small"],
  ]);
  const step = (by, part, extra = []) =>
    ev(by, [
      ["l", "creaton-task"],
      ["task-part", part],
      ["task", task.id],
      ["e", task.id],
      ...extra,
    ]);
  const accept = step(HELPER, "accept");
  const evidence = step(HELPER, "evidence", [
    ["task-link", "https://example.org/r"],
  ]);
  const confirm = step(confirmer, "confirm", [["task-evidence", evidence.id]]);
  return { task, accept, evidence, confirm };
}

test("work accepted is an item when the project's own rules accept it: confirmed by the team, not by the helper", () => {
  const good = acceptedWork(MATE);
  const records = [good.task, good.accept, good.evidence, good.confirm].map(
    (e) => parseTaskRecord(e),
  );
  assert.ok(records.every(Boolean));
  const out = items([good.confirm], records);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "work");
  assert.equal(out[0].what, "Test sign-up");
  assert.equal(out[0].helper, HELPER);
  assert.equal(out[0].author, MATE);
  assert.equal(itemLabel(out[0]), "Work accepted");
  assert.deepEqual(confirmedTaskIds([good.confirm, good.accept]), [
    good.task.id,
  ]);

  // The helper confirming their own work, or a stranger confirming it, accepts nothing.
  for (const who of [HELPER, STRANGER]) {
    const bad = acceptedWork(who);
    const badRecords = [bad.task, bad.accept, bad.evidence, bad.confirm].map(
      (e) => parseTaskRecord(e),
    );
    assert.deepEqual(items([bad.confirm], badRecords), []);
  }
});

test("items come newest first, and a record dated ahead is shown as signed now, not above everything", () => {
  const old = ev(FOUNDER, [["update-kind", "weekly"]], NOW - 500);
  const ahead = ev(FOUNDER, [["update-kind", "weekly"]], NOW + 800);
  const recent = ev(FOUNDER, [["update-kind", "weekly"]], NOW - 5);
  const out = items([old, ahead, recent]);
  assert.equal(out[0].id, ahead.id);
  assert.equal(out[0].at, NOW);
  assert.deepEqual(
    out.map((i) => i.id),
    [ahead.id, recent.id, old.id],
  );
});

test("a record about a project that is not in view is not an item", () => {
  const other = ev(FOUNDER, [["update-kind", "weekly"]]);
  other.tags[0] = ["a", `37001:${FOUNDER}:other`];
  assert.deepEqual(items([other]), []);
});
