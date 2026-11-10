import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchUpdate } from "../models.ts";
import { parseTaskRecord, taskEvent, taskStepEvent } from "./tasks.ts";
import {
  acceptedLine,
  confirmedByLine,
  tieLine,
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
    byFounder: false,
    onTeam: false,
    selfMade: false,
    sameOffer: 0,
    links: ["https://example.org/a"],
    files: [],
  });
  assert.equal(
    acceptedLine(got),
    "1 piece of work accepted, on 1 project, confirmed by 1 person",
  );
  assert.equal(
    confirmedByLine(got.accepted[0], () => "Max"),
    "confirmed by a team member, Max",
  );
  assert.equal(tieLine(got.accepted[0]), null);
  assert.equal(acceptedLine(record([t])), "0 pieces of work accepted");

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

test("naming an offer a person once made puts nothing on their record", () => {
  // The project names the person's offer, dates the task in the past, and even sends "work" back.
  const t = task(FOUNDER, COORD, {
    offerId: "2".repeat(64),
    due: "2020-01-01",
  });
  const got = record([
    t,
    step(MATE, t, "send-back", {
      evidenceId: "e".repeat(64),
      note: "Late and bad.",
    }),
    step(FOUNDER, t, "cancel", { note: "Never showed up." }),
  ]);
  assert.equal(got.open, 0);
  assert.equal(got.sentBack, 0);
  assert.equal(got.givenUp, 0);
  assert.equal(got.accepted.length, 0);
  // It is said that the team recorded steps the person signed nothing for; it is not counted.
  assert.equal(got.stepsMissing, 1);
  assert.equal(missesLine(got), null);
  // When it is known the person removed nothing, the team's steps answer nothing of theirs: not even that is said.
  const clean = helperRecord({
    person: HELPER,
    records: [
      t,
      step(MATE, t, "send-back", { evidenceId: "e".repeat(64), note: "x" }),
    ].flatMap((e) => parseTaskRecord(e) ?? []),
    teams: TEAMS,
    now: NOW,
    mayHaveRemoved: false,
  });
  assert.equal(clean.stepsMissing, 0);
});

test("a give-up stays counted when work is confirmed after it, and when the team changed since", () => {
  const t = task();
  const yes = step(HELPER, t, "accept");
  const quit = step(HELPER, t, "give-up");
  const work = step(HELPER, t, "evidence", { note: "Did it after all." });
  const ok = step(MATE, t, "confirm", { evidenceId: work.id });
  const got = record([t, yes, quit, work, ok]);
  assert.equal(got.accepted.length, 1);
  assert.equal(got.givenUp, 1);

  // The founder leaves only themselves on the team, and the task was made by the one who left: the helper's own
  // signed yes and give-up are still theirs.
  const byMate = task(MATE);
  const records = [
    byMate,
    step(HELPER, byMate, "accept"),
    step(HELPER, byMate, "give-up"),
  ];
  const later = record(records, {
    teams: new Map([[COORD, new Set([FOUNDER])]]),
  });
  assert.equal(later.givenUp, 1);
  assert.equal(later.outsideTasks, 1);
  // And where the project's record cannot be read at all.
  const unread = record(records, { teams: new Map() });
  assert.equal(unread.givenUp, 1);
  assert.equal(unread.unreadProjects, 1);
});

test("a send-back by someone who left the team is shown apart, and one of removed work still counts", () => {
  const t = task();
  const work = step(HELPER, t, "evidence", { note: "x" });
  const back = step(MATE, t, "send-back", { evidenceId: work.id, note: "No." });
  assert.equal(record([t, work, back]).sentBack, 1);
  const after = record([t, work, back], {
    teams: new Map([[COORD, new Set([FOUNDER])]]),
  });
  assert.equal(after.sentBack, 0);
  assert.equal(after.outsideAnswers, 1);
  // The helper removed the work that was sent back; their yes is still there.
  const gone = record([t, step(HELPER, t, "accept"), back]);
  assert.equal(gone.sentBack, 1);
  assert.equal(gone.sentBackWorkRemoved, 1);
  assert.equal(
    missesLine(gone),
    "1 task sent back at least once (the work on 1 was later removed), 0 given up",
  );
});

test("the headline lets a reader judge: projects, confirmers, ties to the project, and one-person confirming", () => {
  const SIDE = `37001:${HELPER}:side`;
  const teams = new Map([
    [COORD, new Set([FOUNDER, MATE])],
    // The person's own project, with one teammate.
    [SIDE, new Set([HELPER, STRANGER])],
  ]);
  const done = (t, by, coordinate = COORD) => {
    const work = step(HELPER, t, "evidence", { note: "x" }, NOW, coordinate);
    return [
      t,
      work,
      step(by, t, "confirm", { evidenceId: work.id }, NOW, coordinate),
    ];
  };
  const outside = task();
  const outside2 = task();
  // Two tasks made from one offer.
  const twinA = task(FOUNDER, COORD, { offerId: "7".repeat(64) });
  const twinB = task(FOUNDER, COORD, { offerId: "7".repeat(64) });
  const own = task(HELPER, SIDE);
  const own2 = task(STRANGER, SIDE);
  const got = record(
    [
      ...done(outside, FOUNDER),
      ...done(outside2, FOUNDER),
      ...done(twinA, FOUNDER),
      ...done(twinB, FOUNDER),
      ...done(own, STRANGER, SIDE),
      ...done(own2, STRANGER, SIDE),
    ],
    { teams },
  );
  // Four tasks on the first project are three pieces: the two from one offer count once.
  assert.equal(got.accepted.length, 5);
  assert.equal(
    acceptedLine(got),
    "5 pieces of work accepted, on 2 projects, confirmed by 2 people",
  );
  const twin = got.accepted.find((w) => w.sameOffer > 0);
  assert.equal(twin.sameOffer, 1);
  assert.equal("offerId" in twin, false);
  const mine = got.accepted.find((w) => w.taskId === own.id);
  assert.equal(mine.selfMade, true);
  assert.equal(mine.onTeam, true);
  assert.match(tieLine(mine), /made this task for themselves/);
  assert.equal(
    tieLine(got.accepted.find((w) => w.taskId === own2.id)),
    "They were on this project's team",
  );
  const byFounder = got.accepted.find((w) => w.taskId === outside.id);
  assert.equal(byFounder.byFounder, true);
  assert.equal(
    confirmedByLine(byFounder, () => "Fay"),
    "confirmed by the project's founder, Fay",
  );
  // One person confirmed everything on each project: both are flagged.
  assert.deepEqual(
    got.soleConfirmer.map((s) => [s.coordinate, s.by, s.pieces]).sort(),
    [
      [COORD, FOUNDER, 3],
      [SIDE, STRANGER, 2],
    ].sort(),
  );
  // With a second confirmer on a project it is not flagged.
  const mixed = record([...done(outside, FOUNDER), ...done(outside2, MATE)], {
    teams,
  });
  assert.deepEqual(mixed.soleConfirmer, []);
  assert.equal(mixed.confirmers, 2);
});
