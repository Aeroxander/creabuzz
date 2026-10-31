import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkEveryDays,
  checkNoteContent,
  checkNoteProblem,
  checkTiming,
  coveredClaims,
  draftCheckNote,
  parseCheckNotes,
} from "./checkNote.ts";

const DAY = 86_400;
const START = 1_800_000_000;
const FOUNDER = "f".repeat(64);

test("a team checks weekly in its first month, then every two weeks, and reads as quiet a week past due", () => {
  assert.equal(checkEveryDays(START, START + 29 * DAY), 7);
  assert.equal(checkEveryDays(START, START + 30 * DAY), 14);
  // No note yet: the first is due a week after the start.
  const first = checkTiming(START, null, START + 6 * DAY);
  assert.deepEqual(first, { dueAt: START + 7 * DAY, due: false, quiet: false });
  assert.equal(checkTiming(START, null, START + 7 * DAY).due, true);
  assert.equal(checkTiming(START, null, START + 14 * DAY).quiet, true);
  // A note at day 40: the next is due two weeks later.
  const later = checkTiming(START, START + 40 * DAY, START + 50 * DAY);
  assert.equal(later.dueAt, START + 54 * DAY);
  assert.equal(later.due, false);
});

const claims = [
  { key: "b:1", title: "Write the guide", status: "Paid" },
  { key: "b:2", title: "Translate", status: "Rejected" },
  { key: "b:3", title: "Fix the form", status: "Approved" },
  { key: "b:4", title: "Logo", status: "Open" },
  { key: "b:5", title: "Old work", status: "Paid" },
];

function draft(overrides = {}) {
  return draftCheckNote({
    since: START,
    now: START + 14 * DAY,
    focus: [
      {
        text: "Ship the first guide",
        expect: "Two newcomers submit work",
        checkBy: START + 10 * DAY,
      },
      { text: "Find a reviewer", expect: "", checkBy: null },
    ],
    claims,
    covered: new Set(["b:5"]),
    causesOf: (key) =>
      key === "b:2" ? ["Unclear 'done when'", "Unclear 'done when'"] : [],
    takings: [
      { until: START + 3 * DAY, released: false },
      { until: START + 5 * DAY, released: true },
      { until: START + 30 * DAY, released: false },
      { until: START - DAY, released: false },
    ],
    ...overrides,
  });
}

test("the draft fills in what the records say, and lists each piece of work once across notes", () => {
  const note = draft();
  assert.deepEqual(
    note.finished.map((c) => c.key),
    ["b:1", "b:3"],
  );
  assert.deepEqual(
    note.turnedDown.map((c) => c.key),
    ["b:2"],
  );
  // Two reviewers naming the same cause for one claim count once.
  assert.deepEqual(note.causes, [{ label: "Unclear 'done when'", count: 1 }]);
  assert.equal(note.stuck, "Waiting on review: Logo.");
  // Only dates inside the period that were not let go.
  assert.equal(note.lapsed, 1);
  assert.deepEqual(note.items[0], {
    text: "Ship the first guide",
    expected: "Two newcomers submit work",
    checkBy: START + 10 * DAY,
    happened: null,
    why: "",
    next: null,
  });
  // The founder's parts start empty.
  assert.equal(note.outside, "");
  assert.equal(note.change, "");
});

test("the founder says what changed, answers each expectation, decides each item, and names one change", () => {
  const note = draft();
  assert.match(checkNoteProblem(note), /what changed/);
  note.outside = "Two teachers used the guide in class.";
  assert.match(checkNoteProblem(note), /happened/);
  note.items[0].happened = "partly";
  assert.match(checkNoteProblem(note), /keep, change or drop/);
  note.items[0].next = "keep";
  note.items[1].next = "drop";
  assert.match(checkNoteProblem(note), /one thing the team changes/);
  note.change = "Rewrite the translation work's 'done when'.";
  assert.equal(checkNoteProblem(note), null);
});

test("a published note reads back, only from the founder, newest first, and its work counts as covered", () => {
  const note = draft();
  note.outside = "Two teachers used the guide in class.";
  note.items[0].happened = "partly";
  note.items[0].why = "One submitted, one is still writing";
  note.items[0].next = "keep";
  note.items[1].next = "drop";
  note.change = "Rewrite the translation work's 'done when'.";
  const content = checkNoteContent(note, START + 14 * DAY);
  assert.match(content.title, /^Check note, /);
  assert.match(
    content.body,
    /We expected Two newcomers submit work by .*: Partly\./,
  );
  assert.match(content.body, /Next: drop\./);
  assert.match(content.body, /1 "taking this on" date passed/);
  const event = (pubkey, at, body = content) => ({
    id: `${pubkey}${at}`,
    pubkey,
    kind: 47003,
    created_at: at,
    content: JSON.stringify(body),
  });
  const read = parseCheckNotes(
    [
      event(FOUNDER, START + 14 * DAY),
      event(FOUNDER, START + 20 * DAY),
      // Someone else's note on the project, and an ordinary update, are not check notes.
      event("a".repeat(64), START + 30 * DAY),
      event(FOUNDER, START + 31 * DAY, { title: "News", body: "Hi" }),
    ],
    FOUNDER,
  );
  assert.equal(read.length, 2);
  assert.equal(read[0].createdAt, START + 20 * DAY);
  assert.equal(read[0].items[0].happened, "partly");
  assert.equal(read[0].items[1].next, "drop");
  assert.deepEqual([...coveredClaims(read)].sort(), ["b:1", "b:2", "b:3"]);
  // The next draft, from those notes, lists nothing already reported.
  const next = draft({ covered: new Set([...coveredClaims(read), "b:5"]) });
  assert.deepEqual(next.finished, []);
  assert.deepEqual(next.turnedDown, []);
  assert.throws(() => checkNoteContent(draft(), START), /what changed/);
});
