import assert from "node:assert/strict";
import test from "node:test";

process.env.TZ = "UTC";

import {
  RECORD_CUT_LINE,
  recordLine,
  scorecardSlug,
  SEE_FULL_RECORD,
} from "./record-line.ts";

const DAY = 86_400;
// Monday 2026-11-16, midday.
const NOW = Date.parse("2026-11-16T12:00:00Z") / 1000;
const known = {
  now: NOW,
  startedAt: NOW - 30 * DAY,
  lastUpdateAt: NOW - 3 * DAY,
  updatesKnown: true,
  streak: 0,
  promises: { kept: 0, missed: 0, changed: 0 },
  acceptedByOthers: 0,
  doneByFounder: 0,
  locale: "en-US",
};
const words = (over) =>
  recordLine({ ...known, ...over }).parts.map((p) => p.text);

test("no data at all: no part, and one line that says part of the record did not load", () => {
  const line = recordLine({
    now: NOW,
    startedAt: null,
    lastUpdateAt: null,
    updatesKnown: false,
    streak: null,
    promises: null,
    acceptedByOthers: null,
    doneByFounder: null,
    locale: "en-US",
  });
  assert.deepEqual(line.parts, []);
  assert.equal(line.cut, RECORD_CUT_LINE);
  assert.equal(
    RECORD_CUT_LINE,
    "Some of this record didn't load. A missing number is not zero.",
  );
  assert.equal(SEE_FULL_RECORD, "See the full record");
});

test("a brand-new project: when it started and when its first update is due", () => {
  const line = recordLine({
    ...known,
    startedAt: NOW - 3 * DAY,
    lastUpdateAt: null,
  });
  assert.deepEqual(
    line.parts.map((p) => [p.id, p.text]),
    [
      ["started", "Started 3 days ago"],
      ["first-update", "First update due Fri, Nov 20"],
    ],
  );
  assert.equal(line.cut, null);
  // Started today: due in a week.
  assert.deepEqual(words({ startedAt: NOW - 60, lastUpdateAt: null }), [
    "Started just now",
    "First update due Mon, Nov 23",
  ]);
  // A week with no first update is late, in words and not in red.
  const late = recordLine({
    ...known,
    startedAt: NOW - 9 * DAY,
    lastUpdateAt: null,
  });
  assert.deepEqual(
    late.parts.map((p) => [p.text, p.tone]),
    [
      ["Started Nov 7", "neutral"],
      ["Late by 2 days", "warning"],
    ],
  );
  // No start date known: nothing is invented.
  assert.deepEqual(words({ startedAt: null, lastUpdateAt: null }), []);
});

test("freshness is one part: posted today, the next date, or how late", () => {
  assert.deepEqual(words({ lastUpdateAt: NOW - 60 }), ["Posted today"]);
  assert.deepEqual(words({ lastUpdateAt: NOW - 3 * DAY }), [
    "Next update Fri, Nov 20",
  ]);
  assert.deepEqual(words({ lastUpdateAt: NOW - 7 * DAY }), [
    "Next update today",
  ]);
  const late = recordLine({ ...known, lastUpdateAt: NOW - 9 * DAY });
  assert.deepEqual(
    late.parts.map((p) => [p.text, p.tone]),
    [["Late by 2 days", "warning"]],
  );
});

test("a run shows from two weeks, and promises say what was kept and only then what was missed", () => {
  assert.deepEqual(words({ streak: 1 }), ["Next update Fri, Nov 20"]);
  assert.deepEqual(words({ streak: 3 }), [
    "Next update Fri, Nov 20",
    "3 weeks in a row",
  ]);
  assert.deepEqual(
    words({ promises: { kept: 4, missed: 0, changed: 0 } }).slice(1),
    ["Kept 4 of 4 promises"],
  );
  assert.deepEqual(
    words({ promises: { kept: 4, missed: 1, changed: 0 } }).slice(1),
    ["Kept 4 of 5 promises, 1 missed"],
  );
  assert.deepEqual(
    words({ promises: { kept: 1, missed: 0, changed: 0 } }).slice(1),
    ["Kept 1 of 1 promise"],
  );
  assert.deepEqual(
    words({ promises: { kept: 3, missed: 1, changed: 1 } }).slice(1),
    ["Kept 3 of 5 promises, 1 missed, 1 changed"],
  );
});

test("solo only: the founder's own checks are said as done, checked by the founder, and never accepted", () => {
  const parts = words({ doneByFounder: 1 });
  assert.deepEqual(parts.slice(1), [
    "1 piece of work done, checked by the founder",
  ]);
  assert.equal(
    parts.some((t) => /accept/i.test(t)),
    false,
  );
  assert.deepEqual(
    words({ doneByFounder: 2, viewerIsFounder: true }).slice(1),
    ["2 pieces of work done, checked by you"],
  );
});

test("others only: work accepted by others", () => {
  assert.deepEqual(words({ acceptedByOthers: 2 }).slice(1), [
    "2 pieces of work accepted by others",
  ]);
  assert.deepEqual(words({ acceptedByOthers: 1 }).slice(1), [
    "1 piece of work accepted by others",
  ]);
});

test("both kinds of work are two chips, never added together, in a fixed order", () => {
  const line = recordLine({
    ...known,
    streak: 4,
    promises: { kept: 4, missed: 1, changed: 0 },
    acceptedByOthers: 2,
    doneByFounder: 1,
  });
  assert.deepEqual(
    line.parts.map((p) => p.id),
    ["freshness", "streak", "kept", "accepted", "done-alone"],
  );
  assert.deepEqual(
    line.parts.slice(3).map((p) => p.text),
    [
      "2 pieces of work accepted by others",
      "1 piece of work done, checked by the founder",
    ],
  );
  assert.equal(
    line.parts.some((p) => /3 pieces/.test(p.text)),
    false,
  );
  assert.equal(line.cut, null);
});

test("a cut read leaves the part it could not read out, shows one line, and never shows a zero", () => {
  const line = recordLine({
    ...known,
    streak: null,
    promises: null,
    acceptedByOthers: 3,
    doneByFounder: null,
  });
  assert.deepEqual(
    line.parts.map((p) => p.id),
    ["freshness", "accepted"],
  );
  assert.equal(line.cut, RECORD_CUT_LINE);
  // Nothing is ever worded as a zero.
  for (const text of recordLine({ ...known }).parts.map((p) => p.text))
    assert.doesNotMatch(text, /\b0\b/);
  assert.equal(recordLine({ ...known }).cut, null);
});

test("the link goes to the project's scorecard, named by id and the start of the founder's key", () => {
  assert.equal(
    scorecardSlug({ id: "orbit", author: "AB".repeat(32) }),
    "orbit-abababababababab",
  );
});
