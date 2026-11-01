import assert from "node:assert/strict";
import { test } from "node:test";

import {
  areaKey,
  checkDue,
  dayEnd,
  dayOf,
  emptyFocusItem,
  focusDueForReview,
  focusProblem,
  focusTemplate,
  myTaking,
  parseFocus,
  parseTakenOn,
  takeOnDraft,
  takeOnFromDraft,
  takeOnProblem,
  takenOnTemplate,
  takersByArea,
} from "./projectStructure.ts";

const FOUNDER = "f".repeat(64);
const ANA = "a".repeat(64);
const BO = "b".repeat(64);
const LAUNCH = { author: FOUNDER, id: "docs-commons" };
const COORD = `37001:${FOUNDER}:docs-commons`;
const BUDGET = `0x${"11".repeat(20)}`;
const AREA = areaKey(BUDGET, `0x${"22".repeat(32)}`);
const OTHER = areaKey(BUDGET, `0x${"33".repeat(32)}`);
const NOW = 1_800_000_000;
const DAY = 86_400;

const signed = (template, pubkey, createdAt) => ({
  ...template,
  id: `${pubkey}${createdAt}`,
  pubkey,
  created_at: createdAt,
});

test("a work area is named the same way however its address was written", () => {
  assert.equal(
    areaKey(BUDGET.toUpperCase().replace("0X", "0x"), `0x${"22".repeat(32)}`),
    AREA,
  );
  assert.throws(() => areaKey("docs", "0x22"));
});

test("taking work on: the form asks what, for whom and by when, and refuses a date past 90 days", () => {
  const draft = takeOnDraft(NOW);
  assert.equal(draft.untilDay, dayOf(NOW + 14 * DAY));
  assert.equal(takeOnProblem(draft, NOW)?.field, "deliver");
  const filled = {
    ...draft,
    deliver: "A first guide",
    for: "New contributors",
  };
  assert.equal(takeOnProblem(filled, NOW), null);
  assert.equal(takeOnProblem({ ...filled, for: " " }, NOW)?.field, "for");
  assert.equal(
    takeOnProblem({ ...filled, untilDay: dayOf(NOW - DAY) }, NOW)?.field,
    "untilDay",
  );
  assert.equal(
    takeOnProblem({ ...filled, untilDay: dayOf(NOW + 91 * DAY) }, NOW)?.field,
    "untilDay",
  );
  assert.equal(
    takeOnProblem({ ...filled, deliver: "x".repeat(281) }, NOW)?.field,
    "deliver",
  );

  const template = takeOnFromDraft(filled, {
    launch: COORD,
    area: AREA,
    now: NOW,
  });
  assert.equal(template.kind, 37019);
  assert.deepEqual(template.tags, [
    ["d", AREA],
    ["a", COORD],
  ]);
  const read = parseTakenOn(signed(template, ANA, NOW), COORD);
  assert.equal(read.deliver, "A first guide");
  assert.equal(read.for, "New contributors");
  assert.equal(read.released, false);
  // The end of the chosen day, in this computer's time.
  assert.equal(dayOf(read.until), filled.untilDay);
});

test("who is on a work area: each person's newest, not released, not past its date, soonest first", () => {
  const take = (who, area, until, at, released = false) =>
    parseTakenOn(
      signed(
        takenOnTemplate({
          launch: COORD,
          area,
          deliver: "Work",
          for: "Readers",
          until,
          released,
        }),
        who,
        at,
      ),
      COORD,
    );
  const records = [
    take(ANA, AREA, NOW + 10 * DAY, NOW - 5),
    // Ana changed her date later: the newer one counts.
    take(ANA, AREA, NOW + 3 * DAY, NOW - 1),
    take(BO, AREA, NOW + 7 * DAY, NOW - 2),
    // Bo let the other area go.
    take(BO, OTHER, NOW + 7 * DAY, NOW - 9),
    take(BO, OTHER, NOW + 7 * DAY, NOW - 3, true),
    // A date that passed is no longer shown, without blame.
    take(FOUNDER, AREA, NOW - 1, NOW - 100),
  ];
  const byArea = takersByArea(records, NOW);
  assert.deepEqual(
    byArea.get(AREA).map((r) => [r.author, r.until]),
    [
      [ANA, NOW + 3 * DAY],
      [BO, NOW + 7 * DAY],
    ],
  );
  assert.equal(byArea.has(OTHER), false);
  // The founder's own lapsed record is still theirs to see and renew.
  assert.equal(myTaking(records, FOUNDER, AREA).until, NOW - 1);
  assert.equal(myTaking(records, BO, OTHER).released, true);
  assert.equal(myTaking(records, null, AREA), null);
  // The form starts from a live one, and from fresh dates after a release.
  assert.equal(takeOnDraft(NOW, myTaking(records, ANA, AREA)).deliver, "Work");
  assert.equal(
    takeOnDraft(NOW, myTaking(records, BO, OTHER)).untilDay,
    dayOf(NOW + 14 * DAY),
  );
});

test("a record for another launch, or not well formed, is not read", () => {
  const good = takenOnTemplate({
    launch: COORD,
    area: AREA,
    deliver: "Work",
    for: "Readers",
    until: NOW,
  });
  assert.equal(parseTakenOn(signed(good, ANA, NOW), `37001:${BO}:x`), null);
  assert.equal(
    parseTakenOn(signed({ ...good, content: "{}" }, ANA, NOW), COORD),
    null,
  );
  assert.equal(
    parseTakenOn(
      signed(
        {
          ...good,
          tags: [
            ["d", "docs"],
            ["a", COORD],
          ],
        },
        ANA,
        NOW,
      ),
      COORD,
    ),
    null,
  );
});

const item = (text, area = null, more = {}) => ({
  ...emptyFocusItem(),
  text,
  area,
  ...more,
});
const draft = (now, notDoing = [], aim = "") => ({
  aim,
  now,
  notDoing,
  applied: null,
});
/** An item without its id, for records whose ids are made when read. */
const words = ({ id: _, ...rest }) => rest;

test("the focus is the launch author's newest; anyone else's is ignored", () => {
  const guide = item("Ship the first guide", AREA, {
    why: "Newcomers can't submit without it",
    expect: "Three newcomers submit work",
    checkBy: NOW + 14 * DAY,
  });
  const reviewer = item("Find a second reviewer");
  const focus = draft(
    [guide, reviewer, item("  ")],
    [{ text: "A mobile app", why: "Not before the guide works" }],
    "Teachers who want open lesson plans, written with them",
  );
  const template = focusTemplate(LAUNCH, focus);
  assert.equal(template.kind, 37020);
  assert.deepEqual(template.tags, [
    ["d", "docs-commons"],
    ["a", COORD],
  ]);
  const older = focusTemplate(LAUNCH, draft([]));
  const read = parseFocus(
    [
      signed(older, FOUNDER, NOW - 50),
      signed(template, FOUNDER, NOW - 10),
      // Someone else's record for the same launch is not the project's focus, however new.
      signed(focusTemplate(LAUNCH, draft([])), ANA, NOW),
    ],
    LAUNCH,
  );
  assert.equal(
    read.aim,
    "Teachers who want open lesson plans, written with them",
  );
  assert.deepEqual(read.now, [guide, reviewer]);
  assert.deepEqual(read.notDoing, [
    { text: "A mobile app", why: "Not before the guide works" },
  ]);
  assert.equal(read.createdAt, NOW - 10);
  assert.equal(parseFocus([], LAUNCH), null);
});

test("a focus saved before the aim and predictions existed still reads", () => {
  const old = {
    kind: 37020,
    tags: [
      ["d", "docs-commons"],
      ["a", COORD],
    ],
    content: JSON.stringify({ now: [{ text: "Ship it", area: AREA }] }),
  };
  const read = parseFocus([signed(old, FOUNDER, NOW)], LAUNCH);
  assert.equal(read.aim, "");
  assert.deepEqual(read.now.map(words), [words(item("Ship it", AREA))]);
});

test("what we expect needs a day to check it, and the day needs something to check", () => {
  assert.match(
    focusProblem(draft([item("a", null, { expect: "Ten sign-ups" })])),
    /Check by/,
  );
  assert.match(
    focusProblem(draft([item("a", null, { checkBy: NOW })])),
    /what you expect/,
  );
  assert.match(focusProblem(draft([], [], "x".repeat(201))), /aim/);
  const due = item("a", null, { expect: "Ten sign-ups", checkBy: NOW });
  assert.equal(checkDue(due, NOW - 1), false);
  assert.equal(checkDue(due, NOW), true);
  assert.equal(checkDue(item("a"), NOW), false);
  // The date box's day is checked at its end, in this computer's time.
  assert.equal(dayOf(dayEnd(dayOf(NOW))), dayOf(NOW));
  assert.equal(dayEnd("soon"), null);
});

test("Now holds three at most, and the founder is asked again after four weeks", () => {
  const four = Array.from({ length: 4 }, (_, i) => item(`item ${i}`));
  assert.match(focusProblem(draft(four)), /Keep Now to 3/);
  assert.throws(() => focusTemplate(LAUNCH, draft(four)));
  assert.equal(
    focusProblem(draft([item("a", "docs")])),
    "Pick the work area again.",
  );
  const set = { ...draft([item("a")]), createdAt: NOW };
  assert.equal(focusDueForReview(set, NOW + 27 * DAY), false);
  assert.equal(focusDueForReview(set, NOW + 28 * DAY), true);
  assert.equal(focusDueForReview({ ...set, now: [] }, NOW + 60 * DAY), false);
});

test("each Now item keeps its id across saves, and the focus says which check note it applied", () => {
  const a = emptyFocusItem();
  const b = emptyFocusItem();
  assert.notEqual(a.id, b.id);
  const applied = "c".repeat(64);
  const template = focusTemplate(LAUNCH, {
    aim: "",
    applied,
    now: [
      { ...a, text: "Documentation" },
      { ...b, text: "Documentation" },
    ],
    notDoing: [],
  });
  const read = parseFocus([signed(template, FOUNDER, NOW)], LAUNCH);
  assert.deepEqual(
    read.now.map((i) => i.id),
    [a.id, b.id],
  );
  assert.equal(read.applied, applied);
});

test("a focus saved before items had ids gets ids that stay the same each time it is read", () => {
  const old = signed(
    {
      kind: 37020,
      tags: [
        ["d", "docs-commons"],
        ["a", COORD],
      ],
      content: JSON.stringify({
        now: [{ text: "Documentation" }, { text: "Documentation" }],
      }),
    },
    FOUNDER,
    NOW,
  );
  const first = parseFocus([old], LAUNCH);
  const again = parseFocus([old], LAUNCH);
  assert.deepEqual(
    first.now.map((i) => i.id),
    again.now.map((i) => i.id),
  );
  assert.notEqual(first.now[0].id, first.now[1].id);
  assert.equal(first.applied, null);
});
