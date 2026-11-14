import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTaskRecord,
  taskEvent,
  taskStepEvent,
} from "../../launchpad/lib/tasks.ts";
import { myWork } from "./my-work.ts";

const FOUNDER = "f".repeat(64);
const ME = "a".repeat(64);
const STRANGER = "b".repeat(64);
const COORD = `37001:${FOUNDER}:demo`;
const TEAMS = new Map([[COORD, new Set([FOUNDER])]]);
const DAY = 86_400;
const NOW = 1_794_312_000;

let n = 0;
function signed(pubkey, built, at) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 47003,
    tags: [["a", COORD], ...built.tags],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}
const make = (who, what, at, over = {}) =>
  signed(
    who,
    taskEvent({
      helper: ME,
      what,
      done: "It works.",
      size: "small",
      ...over,
    }),
    at,
  );
const step = (who, task, part, at, over = {}) =>
  signed(who, taskStepEvent({ part, taskId: task.id, tell: [], ...over }), at);
const work = (events, teams = TEAMS) =>
  myWork({
    person: ME,
    records: events.flatMap((e) => parseTaskRecord(e) ?? []),
    teams,
    now: NOW,
  });
const dates = (item) => item.steps.map((s) => [s.id, s.done, s.at]);

test("a task I said yes to shows offered and accepted with their dates, and the rest still to come", () => {
  const task = make(FOUNDER, "Write the readme.", NOW - 5 * DAY);
  const [item] = work([task, step(ME, task, "accept", NOW - 4 * DAY)]);
  assert.deepEqual(dates(item), [
    ["offered", true, NOW - 5 * DAY],
    ["accepted", true, NOW - 4 * DAY],
    ["handed-in", false, null],
    ["checked", false, null],
  ]);
});

test("handed in and accepted work carries all four dates; a date ahead of now shows as now", () => {
  const task = make(FOUNDER, "Draw the logo.", NOW - 9 * DAY);
  const yes = step(ME, task, "accept", NOW - 8 * DAY);
  const proof = step(ME, task, "evidence", NOW - 3 * DAY, {
    links: ["https://example.org/a"],
  });
  const ok = step(FOUNDER, task, "confirm", NOW + 30 * DAY, {
    evidenceId: proof.id,
  });
  const [item] = work([task, yes, proof, ok]);
  assert.equal(item.task.state, "confirmed");
  assert.deepEqual(dates(item), [
    ["offered", true, NOW - 9 * DAY],
    ["accepted", true, NOW - 8 * DAY],
    ["handed-in", true, NOW - 3 * DAY],
    ["checked", true, NOW],
  ]);
  assert.equal(item.steps[3].label, "Work accepted");
});

test("work sent back says so on the last step", () => {
  const task = make(FOUNDER, "Fix the form.", NOW - 9 * DAY);
  const proof = step(ME, task, "evidence", NOW - 3 * DAY, {
    links: ["https://example.org/a"],
  });
  const back = step(FOUNDER, task, "send-back", NOW - 2 * DAY, {
    evidenceId: proof.id,
    note: "Not yet.",
  });
  const [item] = work([task, proof, back]);
  assert.equal(item.steps[3].label, "Sent back");
  assert.equal(item.steps[3].at, NOW - 2 * DAY);
  // Handing work in is agreement, with no dated yes of its own.
  assert.deepEqual(dates(item)[1], ["accepted", true, null]);
});

test("a task that only names me, or one a stranger made, is not my work", () => {
  const named = make(FOUNDER, "Never agreed.", NOW - DAY);
  const fake = make(STRANGER, "From a stranger.", NOW - DAY);
  assert.deepEqual(
    work([named, fake, step(ME, fake, "accept", NOW - 3600)]),
    [],
  );
});

test("open tasks come before finished ones, whatever their dates", () => {
  const old = make(FOUNDER, "Open and old.", NOW - 90 * DAY);
  const done = make(FOUNDER, "Finished today.", NOW - 2 * DAY);
  const proof = step(ME, done, "evidence", NOW - DAY, {
    links: ["https://example.org/a"],
  });
  const list = work([
    done,
    proof,
    step(FOUNDER, done, "confirm", NOW - 60, { evidenceId: proof.id }),
    old,
    step(ME, old, "accept", NOW - 89 * DAY),
  ]);
  assert.deepEqual(
    list.map((item) => item.task.what),
    ["Open and old.", "Finished today."],
  );
});
