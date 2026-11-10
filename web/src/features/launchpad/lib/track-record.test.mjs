import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchUpdate } from "../models.ts";
import { parseTaskRecord, taskEvent, taskStepEvent } from "./tasks.ts";
import {
  acceptedLine,
  founderRecord,
  helperRecord,
  missesLine,
  updatesLine,
} from "./track-record.ts";
import { updateEvent } from "./weekly-update.ts";

const FOUNDER = "f".repeat(64);
const MATE = "c".repeat(64);
const HELPER = "a".repeat(64);
const STRANGER = "b".repeat(64);
const COORD = `37001:${FOUNDER}:demo`;
const OTHER = `37001:${STRANGER}:side`;
const NOW = 1_794_312_000;
const DAY = 86_400;
const TEAMS = new Map([
  [COORD, new Set([FOUNDER, MATE])],
  [OTHER, new Set([STRANGER])],
]);

let n = 0;
function event(pubkey, built, at = NOW - DAY, coordinate = COORD) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 47003,
    tags: [["a", coordinate], ...built.tags],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}
const task = (who = FOUNDER, coordinate = COORD, over = {}) =>
  event(
    who,
    taskEvent({
      helper: HELPER,
      what: "Test sign-up.",
      done: "It works.",
      size: "small",
      ...over,
    }),
    NOW - 9 * DAY,
    coordinate,
  );
const step = (who, t, part, over = {}, at, coordinate = COORD) =>
  event(
    who,
    taskStepEvent({ part, taskId: t.id, tell: [], ...over }),
    at,
    coordinate,
  );
const record = (events, over = {}) =>
  helperRecord({
    person: HELPER,
    records: events.flatMap((e) => parseTaskRecord(e) ?? []),
    teams: TEAMS,
    now: NOW,
    ...over,
  });

test("work counts only when someone else on that project's team confirmed it", () => {
  const t = task();
  const work = step(HELPER, t, "evidence", {
    links: ["https://example.org/a"],
  });
  const ok = step(MATE, t, "confirm", { evidenceId: work.id }, NOW - DAY);
  const got = record([t, work, ok]);
  assert.equal(got.accepted.length, 1);
  assert.deepEqual(got.accepted[0], {
    taskId: t.id,
    coordinate: COORD,
    what: "Test sign-up.",
    at: NOW - DAY,
    confirmedBy: MATE,
    links: ["https://example.org/a"],
    files: [],
  });
  assert.equal(acceptedLine(got.accepted.length), "1 piece of work accepted");

  // Confirmed by the helper themselves, or by someone who is not on the team: nothing.
  for (const who of [HELPER, STRANGER])
    assert.equal(
      record([t, work, step(who, t, "confirm", { evidenceId: work.id })])
        .accepted.length,
      0,
    );
  // A "task" made by someone who is not on the project's team, confirmed by them: nothing.
  const fake = task(STRANGER);
  const fakeWork = step(HELPER, fake, "evidence", { note: "x" });
  assert.equal(
    record([
      fake,
      fakeWork,
      step(STRANGER, fake, "confirm", { evidenceId: fakeWork.id }),
    ]).accepted.length,
    0,
  );
  // The confirmation stands, but the evidence was removed: not counted.
  assert.equal(record([t, ok]).accepted.length, 0);
});

test("a helper cannot count work by confirming it as the team of their own project", () => {
  // The helper's own project: they are its whole team, so nobody can confirm their work there.
  const own = `37001:${HELPER}:mine`;
  const teams = new Map([[own, new Set([HELPER])]]);
  const t = task(HELPER, own);
  const work = step(HELPER, t, "evidence", { note: "x" }, NOW, own);
  const ok = step(HELPER, t, "confirm", { evidenceId: work.id }, NOW, own);
  assert.equal(record([t, work, ok], { teams }).accepted.length, 0);
});

test("a project whose record could not be read is not counted either way, and is said", () => {
  const t = task(FOUNDER, "37001:" + FOUNDER + ":gone");
  const work = step(HELPER, t, "evidence", { note: "x" }, NOW, t.tags[0][1]);
  const got = record([
    t,
    work,
    step(MATE, t, "confirm", { evidenceId: work.id }, NOW, t.tags[0][1]),
  ]);
  assert.equal(got.accepted.length, 0);
  assert.equal(got.unreadProjects, 1);
});

test("sent back, given up and open are counted per task; a task never agreed to says nothing", () => {
  const a = task();
  const wa1 = step(HELPER, a, "evidence", { note: "one" });
  const wa2 = step(HELPER, a, "evidence", { note: "two" });
  const b = task();
  const c = task();
  const never = task();
  const declined = task();
  const got = record([
    a,
    wa1,
    wa2,
    step(MATE, a, "send-back", { evidenceId: wa1.id, note: "No." }),
    step(FOUNDER, a, "send-back", { evidenceId: wa2.id, note: "Still no." }),
    b,
    step(HELPER, b, "accept"),
    step(HELPER, b, "give-up"),
    c,
    step(HELPER, c, "accept"),
    never,
    // Turning down a task that was never taken on is not giving up.
    declined,
    step(HELPER, declined, "give-up"),
    // A stranger's "send-back" counts for nothing.
    step(STRANGER, c, "send-back", { evidenceId: wa1.id, note: "x" }),
  ]);
  assert.equal(got.sentBack, 1);
  assert.equal(got.givenUp, 1);
  assert.equal(got.open, 2);
  assert.equal(missesLine(got), "1 task sent back at least once, 1 given up");
  assert.equal(missesLine(record([c])), null);
});

test("accepted work is newest first, and a confirmation dated in the future does not jump the list", () => {
  const a = task();
  const b = task(STRANGER, OTHER);
  const wa = step(HELPER, a, "evidence", { note: "a" });
  const wb = step(HELPER, b, "evidence", { note: "b" }, NOW, OTHER);
  const got = record([
    a,
    b,
    wa,
    wb,
    step(MATE, a, "confirm", { evidenceId: wa.id }, NOW),
    step(STRANGER, b, "confirm", { evidenceId: wb.id }, NOW + 400 * DAY, OTHER),
  ]);
  assert.deepEqual(
    got.accepted.map((w) => w.coordinate),
    [COORD, OTHER],
  );
});

test("a founder's updates and promises count only on their own projects", () => {
  const first = event(
    FOUNDER,
    updateEvent({
      title: "Week 1",
      done: "Shipped.",
      next: "Invite ten people\nFix email",
      body: "",
      help: "",
      helpSize: "small",
      helpTime: "",
    }),
    NOW - 14 * DAY,
  );
  const second = event(
    FOUNDER,
    updateEvent({
      title: "Week 2",
      done: "Invited.",
      next: "",
      body: "",
      help: "",
      helpSize: "small",
      helpTime: "",
      marks: [
        {
          promiseId: `${first.id}:0`,
          text: "Invite ten people",
          state: "done",
          note: "",
        },
        {
          promiseId: `${first.id}:1`,
          text: "Fix email",
          state: "not-done",
          note: "",
        },
      ],
    }),
    NOW - 7 * DAY,
  );
  // On someone else's project, and by someone else on theirs: neither is theirs as a founder.
  const elsewhere = event(
    FOUNDER,
    updateEvent({
      title: "Guest",
      done: "x",
      next: "y",
      body: "",
      help: "",
      helpSize: "small",
      helpTime: "",
    }),
    NOW,
    OTHER,
  );
  const foreign = event(
    STRANGER,
    updateEvent({
      title: "Fake",
      done: "x",
      next: "y",
      body: "",
      help: "",
      helpSize: "small",
      helpTime: "",
    }),
    NOW,
  );
  const updates = [first, second, elsewhere, foreign].map(parseLaunchUpdate);
  const got = founderRecord(FOUNDER, updates);
  assert.equal(got.updates, 2);
  assert.equal(got.projects, 1);
  assert.deepEqual(got.promises, {
    kept: 1,
    missed: 1,
    changed: 0,
    unanswered: 0,
  });
  assert.equal(updatesLine(got), "2 updates posted on 1 project");
  assert.deepEqual(founderRecord(HELPER, updates), {
    projects: 0,
    updates: 0,
    promises: { kept: 0, missed: 0, changed: 0, unanswered: 0 },
  });
});
