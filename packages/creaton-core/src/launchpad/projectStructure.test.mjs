import assert from "node:assert/strict";
import { test } from "node:test";

import {
  areaKey,
  dayOf,
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

test("the focus is the launch author's newest; anyone else's is ignored", () => {
  const focus = {
    now: [
      { text: "Ship the first guide", area: AREA },
      { text: "Find a second reviewer", area: null },
      { text: "  ", area: null },
    ],
    notDoing: [{ text: "A mobile app", why: "Not before the guide works" }],
  };
  const template = focusTemplate(LAUNCH, focus);
  assert.equal(template.kind, 37020);
  assert.deepEqual(template.tags, [
    ["d", "docs-commons"],
    ["a", COORD],
  ]);
  const older = focusTemplate(LAUNCH, { now: [], notDoing: [] });
  const read = parseFocus(
    [
      signed(older, FOUNDER, NOW - 50),
      signed(template, FOUNDER, NOW - 10),
      // Someone else's record for the same launch is not the project's focus, however new.
      signed(focusTemplate(LAUNCH, { now: [], notDoing: [] }), ANA, NOW),
    ],
    LAUNCH,
  );
  assert.deepEqual(read.now, [
    { text: "Ship the first guide", area: AREA },
    { text: "Find a second reviewer", area: null },
  ]);
  assert.deepEqual(read.notDoing, [
    { text: "A mobile app", why: "Not before the guide works" },
  ]);
  assert.equal(read.createdAt, NOW - 10);
  assert.equal(parseFocus([], LAUNCH), null);
});

test("Now holds three at most, and the founder is asked again after four weeks", () => {
  const four = Array.from({ length: 4 }, (_, i) => ({
    text: `item ${i}`,
    area: null,
  }));
  assert.match(focusProblem({ now: four, notDoing: [] }), /Keep Now to 3/);
  assert.throws(() => focusTemplate(LAUNCH, { now: four, notDoing: [] }));
  assert.equal(
    focusProblem({ now: [{ text: "a", area: "docs" }], notDoing: [] }),
    "Pick the work area again.",
  );
  const set = {
    now: [{ text: "a", area: null }],
    notDoing: [],
    createdAt: NOW,
  };
  assert.equal(focusDueForReview(set, NOW + 27 * DAY), false);
  assert.equal(focusDueForReview(set, NOW + 28 * DAY), true);
  assert.equal(focusDueForReview({ ...set, now: [] }, NOW + 60 * DAY), false);
});
