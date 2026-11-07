import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyCheckToFocus,
  checkEveryDays,
  checkNeedsApplying,
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
        id: "i1",
        text: "Ship the first guide",
        expect: "Two newcomers submit work",
        checkBy: START + 10 * DAY,
      },
      { id: "i2", text: "Find a reviewer", expect: "", checkBy: null },
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
    id: "i1",
    text: "Ship the first guide",
    expected: "Two newcomers submit work",
    checkBy: START + 10 * DAY,
    happened: null,
    why: "",
    next: null,
    becomes: "",
  });
  // The founder's parts start empty.
  assert.equal(note.outside, "");
  assert.equal(note.change, "");
});

test("the founder says what changed, supports checked predictions, and decides how to work next", () => {
  const note = draft();
  assert.match(checkNoteProblem(note), /what changed/);
  note.outside = "Two teachers used the guide in class.";
  assert.match(checkNoteProblem(note), /happened/);
  note.items[0].happened = "partly";
  assert.match(checkNoteProblem(note), /what you observed/);
  note.items[0].why = "One newcomer submitted; the other has not tried it yet.";
  assert.match(checkNoteProblem(note), /keep, change or drop/);
  note.items[0].next = "keep";
  note.items[1].next = "drop";
  assert.match(checkNoteProblem(note), /what to keep or change/);
  note.change = "Rewrite the translation work's 'done when'.";
  assert.equal(checkNoteProblem(note), null);
});

test("a checked prediction needs an observation; not-yet and unpredicted work do not", () => {
  for (const happened of ["yes", "partly", "no"]) {
    const note = draft();
    note.outside = "We checked the submission records.";
    note.change = "Keep the review method while we gather more observations.";
    note.items[0].happened = happened;
    note.items[0].next = "keep";
    note.items[1].next = "keep";
    note.items[0].why = "  ";
    assert.match(checkNoteProblem(note), /what you observed/, happened);
    assert.throws(() => checkNoteContent(note, START), /what you observed/);
    note.items[0].why =
      "One newcomer submitted; the other has not tried it yet.";
    assert.equal(checkNoteProblem(note), null, happened);
  }
  const note = draft();
  note.outside = "The check has not happened yet.";
  note.change = "Keep the method and check the result next week.";
  note.items[0].happened = "not-yet";
  note.items.forEach((item) => {
    item.next = "keep";
  });
  assert.equal(checkNoteProblem(note), null);
  assert.equal(
    checkNoteContent(note, START).check.items[0].happened,
    "not-yet",
  );
});

test("keeping the process is published as a valid plan, using the existing record", () => {
  const note = draft({ focus: [] });
  note.outside = "The two reviews caught the expected problems.";
  note.change =
    "Keep the current review method; check the next two submissions before changing it.";
  assert.equal(checkNoteProblem(note), null);
  const content = checkNoteContent(note, START);
  assert.equal(content.check.v, 1);
  assert.equal(content.check.change, note.change);
  assert.match(
    content.body,
    /How we work next: Keep the current review method/,
  );
  const [read] = parseCheckNotes(
    [
      {
        id: "e".repeat(64),
        pubkey: FOUNDER,
        kind: 47003,
        created_at: START,
        content: JSON.stringify(content),
      },
    ],
    FOUNDER,
  );
  assert.equal(read.change, note.change);
});

test("older notes remain readable when a checked prediction has no observation", () => {
  const [read] = parseCheckNotes(
    [
      {
        id: "e".repeat(64),
        pubkey: FOUNDER,
        kind: 47003,
        created_at: START,
        content: JSON.stringify({
          check: {
            v: 1,
            since: START - DAY,
            outside: "The guide was tried.",
            items: [
              {
                text: "Guide",
                expected: "Two people try it",
                happened: "yes",
                next: "keep",
              },
            ],
            change: "Keep working this way.",
          },
        }),
      },
    ],
    FOUNDER,
  );
  assert.equal(read.items[0].happened, "yes");
  assert.equal(read.items[0].why, "");
  assert.equal(read.change, "Keep working this way.");
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

const focusItem = (text, more = {}) => ({
  text,
  area: null,
  why: "",
  expect: "",
  checkBy: null,
  ...more,
});

test("a note is applied to Now: keep stays, change rewrites, drop moves to Not doing, settled expectations clear", () => {
  const focus = {
    aim: "Teachers",
    now: [
      focusItem("Ship the guide", {
        id: "i1",
        expect: "Two submit",
        checkBy: START,
      }),
      focusItem("Find a reviewer", {
        id: "i2",
        expect: "One says yes",
        checkBy: START,
      }),
      focusItem("Run a workshop", { id: "i3" }),
    ],
    notDoing: [{ text: "An app", why: "" }],
    applied: null,
  };
  const note = {
    id: NOTE_ID,
    items: [
      {
        id: "i1",
        text: "Ship the guide",
        expected: "Two submit",
        checkBy: START,
        happened: "not-yet",
        why: "",
        next: "keep",
        becomes: "",
      },
      {
        id: "i2",
        text: "Find a reviewer",
        expected: "One says yes",
        checkBy: START,
        happened: "yes",
        why: "",
        next: "change",
        becomes: "Find two more reviewers",
      },
      {
        id: "i3",
        text: "Run a workshop",
        expected: "",
        checkBy: null,
        happened: null,
        why: "Nobody signed up",
        next: "drop",
        becomes: "",
      },
    ],
  };
  const after = applyCheckToFocus(focus, note);
  assert.equal(after.aim, "Teachers");
  assert.deepEqual(after.now, [
    // Not yet: the expectation still stands.
    focusItem("Ship the guide", {
      id: "i1",
      expect: "Two submit",
      checkBy: START,
    }),
    // Changed: its old expectation went with it, and it keeps its id.
    focusItem("Find two more reviewers", { id: "i2" }),
  ]);
  assert.equal(after.applied, NOTE_ID);
  assert.deepEqual(after.notDoing, [
    { text: "Run a workshop", why: "Nobody signed up" },
    { text: "An app", why: "" },
  ]);
  // Applying it again changes nothing, so a retry never moves an item twice.
  assert.deepEqual(applyCheckToFocus(after, note), after);
});

test("Apply to Now is offered only while the latest note is not in Now yet", () => {
  const note = {
    id: NOTE_ID,
    createdAt: START + 10,
    items: [answer("i1", "Run a workshop", "drop")],
  };
  const before = {
    aim: "",
    now: [focusItem("Run a workshop", { id: "i1" })],
    notDoing: [],
    applied: null,
    createdAt: START,
  };
  assert.equal(checkNeedsApplying(note, before), true);
  const { createdAt: _, ...draftFocus } = before;
  const applied = { ...applyCheckToFocus(draftFocus, note), createdAt: START };
  assert.equal(checkNeedsApplying(note, applied), false);
  assert.equal(checkNeedsApplying(note, null), false);
});

test("a change needs what the item becomes", () => {
  const note = draft();
  note.outside = "x";
  note.change = "y";
  note.items[0].happened = "yes";
  note.items[0].why = "The submission records show two completed submissions.";
  note.items[0].next = "keep";
  note.items[1].next = "change";
  assert.match(checkNoteProblem(note), /becomes/);
  note.items[1].becomes = "Find two reviewers";
  assert.equal(checkNoteProblem(note), null);
  assert.match(
    checkNoteContent(note, START).body,
    /Next: change, to "Find two reviewers"/,
  );
});

// ---- applying by identity (outside review 2026-11-01, claims 2 and 5) ------------------------

const NOTE_ID = "c".repeat(64);
const OLDER_NOTE = "d".repeat(64);
const answer = (id, text, next, more = {}) => ({
  id,
  text,
  expected: "",
  checkBy: null,
  happened: null,
  why: "",
  next,
  becomes: "",
  ...more,
});

test("two Now items with the same words are answered one by one", () => {
  const focus = {
    aim: "",
    applied: null,
    now: [
      focusItem("Documentation", { id: "a1" }),
      focusItem("Documentation", { id: "a2" }),
    ],
    notDoing: [],
  };
  const after = applyCheckToFocus(focus, {
    id: NOTE_ID,
    items: [
      answer("a1", "Documentation", "keep"),
      answer("a2", "Documentation", "drop", { why: "One is enough" }),
    ],
  });
  assert.deepEqual(after.now, [focusItem("Documentation", { id: "a1" })]);
  assert.deepEqual(after.notDoing, [
    { text: "Documentation", why: "One is enough" },
  ]);
  assert.equal(after.applied, NOTE_ID);
});

test("a change into another item's words, then a drop of that item, applies once", () => {
  const focus = {
    aim: "",
    applied: OLDER_NOTE,
    now: [focusItem("A", { id: "i1" }), focusItem("B", { id: "i2" })],
    notDoing: [],
  };
  const note = {
    id: NOTE_ID,
    items: [
      answer("i1", "A", "change", { becomes: "B" }),
      answer("i2", "B", "drop"),
    ],
  };
  const once = applyCheckToFocus(focus, note);
  assert.deepEqual(once.now, [focusItem("B", { id: "i1" })]);
  assert.deepEqual(once.notDoing, [{ text: "B", why: "Dropped at a check" }]);
  // A retry (say after a lost acknowledgement) changes nothing more.
  assert.deepEqual(applyCheckToFocus(once, note), once);
});

test("Apply to Now is offered by the note the focus says it applied, never by the clock", () => {
  const note = {
    id: NOTE_ID,
    createdAt: START + 10,
    items: [
      answer("i1", "A", "change", { becomes: "B" }),
      answer("i2", "B", "drop"),
    ],
  };
  const before = {
    aim: "",
    applied: OLDER_NOTE,
    now: [focusItem("A", { id: "i1" }), focusItem("B", { id: "i2" })],
    notDoing: [],
  };
  // Saved in the same second as the note, and applied: nothing is offered.
  const saved = { ...applyCheckToFocus(before, note), createdAt: START + 10 };
  assert.equal(checkNeedsApplying(note, saved), false);
  // The note went out but the focus save was refused: offered, whatever the times say.
  assert.equal(
    checkNeedsApplying(note, { ...before, createdAt: START + 99 }),
    true,
  );
  // A manual save keeps the marker, so the note stays applied.
  const edited = {
    ...saved,
    now: [...saved.now, focusItem("C", { id: "i3" })],
    createdAt: START + 50,
  };
  assert.equal(checkNeedsApplying(note, edited), false);
});

test("an old note never overwrites later manual changes, and leaves other rows alone", () => {
  const note = {
    id: NOTE_ID,
    items: [
      answer("i1", "A", "change", { becomes: "A, smaller" }),
      answer("i2", "B", "keep", {
        expected: "Ten sign-ups",
        checkBy: START,
        happened: "yes",
      }),
    ],
  };
  // After the note, the founder renamed i1 by hand, set a new expectation on i2 and added i3.
  const focus = {
    aim: "",
    applied: OLDER_NOTE,
    now: [
      focusItem("A, rewritten by hand", { id: "i1" }),
      focusItem("B", { id: "i2", expect: "Twenty sign-ups", checkBy: START }),
      focusItem("C", { id: "i3" }),
    ],
    notDoing: [],
  };
  const after = applyCheckToFocus(focus, note);
  assert.deepEqual(after.now, focus.now);
  assert.equal(after.applied, NOTE_ID);
});

test("a note from before Now items had ids is left for the founder to apply by hand", () => {
  const legacy = {
    id: NOTE_ID,
    createdAt: START,
    items: [{ ...answer(null, "Documentation", "drop") }],
  };
  const focus = {
    aim: "",
    applied: null,
    now: [focusItem("Documentation", { id: "x" })],
    notDoing: [],
    createdAt: START,
  };
  const { createdAt: _, ...draftFocus } = focus;
  assert.deepEqual(applyCheckToFocus(draftFocus, legacy).now, focus.now);
  assert.equal(checkNeedsApplying(legacy, focus), false);
});

test("a note keeps each Now item's id, and reads back with it", () => {
  const note = draftCheckNote({
    since: START,
    now: START + DAY,
    focus: [{ id: "i1", text: "A", expect: "", checkBy: null }],
    claims: [],
    covered: new Set(),
    causesOf: () => [],
    takings: [],
  });
  assert.equal(note.items[0].id, "i1");
  note.outside = "x";
  note.change = "y";
  note.items[0].next = "keep";
  const content = checkNoteContent(note, START + DAY);
  assert.equal(content.check.items[0].id, "i1");
  const [read] = parseCheckNotes(
    [
      {
        id: NOTE_ID,
        pubkey: FOUNDER,
        kind: 47003,
        created_at: START + DAY,
        content: JSON.stringify(content),
      },
    ],
    FOUNDER,
  );
  assert.equal(read.items[0].id, "i1");
});

test("a lapsed date is only a date that passed: the note does not say the work never came", () => {
  // The work was finished and paid, yet its "taking this on" date passed without being let go.
  const note = draftCheckNote({
    since: START,
    now: START + 14 * DAY,
    focus: [],
    claims: [{ key: "b:1", title: "Delivered guide", status: "Paid" }],
    covered: new Set(),
    causesOf: () => [],
    takings: [{ until: START + 3 * DAY, released: false }],
  });
  assert.equal(note.lapsed, 1);
  note.outside = "x";
  note.change = "y";
  const { body } = checkNoteContent(note, START + 14 * DAY);
  assert.match(body, /1 "taking this on" date passed\./);
  assert.doesNotMatch(body, /without the work/);
});
