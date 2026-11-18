import assert from "node:assert/strict";
import { test } from "node:test";

import { weekInReview, weekInReviewLines } from "./week-in-review.ts";

const NOW = 10_000_000;
const DAY = 86_400;
const update = (daysAgo, kept = 0, missed = 0) => ({
  kind: "update",
  id: `u${daysAgo}-${kept}-${missed}`,
  at: NOW - daysAgo * DAY,
  answers: { kept, missed, changed: 0 },
});
const work = (daysAgo) => ({
  kind: "work",
  id: `w${daysAgo}`,
  at: NOW - daysAgo * DAY,
});
const goal = (daysAgo) => ({
  kind: "goal",
  id: `g${daysAgo}`,
  at: NOW - daysAgo * DAY,
  state: "reached",
});
const OLD_SERVER = [NOW - 20 * DAY];

test("the week counts updates, promises kept and missed, accepted work and new projects, from the last seven days", () => {
  const counts = weekInReview({
    items: [
      update(1, 2, 1),
      update(3),
      update(6.5, 1, 0),
      update(9, 5, 5),
      work(2),
      work(8),
      goal(1),
    ],
    starts: [...OLD_SERVER, NOW - 2 * DAY, NOW - 3 * DAY, NOW - 15 * DAY],
    now: NOW,
  });
  assert.deepEqual(counts, {
    updates: 3,
    kept: 3,
    missed: 1,
    work: 1,
    started: 2,
  });
});

test("nothing is shown in the server's first week, however busy", () => {
  assert.equal(
    weekInReview({
      items: [update(1, 3, 0)],
      starts: [NOW - 6 * DAY],
      now: NOW,
    }),
    null,
  );
  assert.notEqual(
    weekInReview({
      items: [update(1, 3, 0)],
      starts: [NOW - 7 * DAY],
      now: NOW,
    }),
    null,
  );
  assert.equal(
    weekInReview({ items: [update(1)], starts: [], now: NOW }),
    null,
  );
});

test("a week with nothing in it is never shown", () => {
  assert.equal(
    weekInReview({
      items: [update(9, 2, 1), work(10), goal(1)],
      starts: OLD_SERVER,
      now: NOW,
    }),
    null,
  );
});

test("the lines leave out what is zero and say 'at least' when the read was short", () => {
  const counts = { updates: 1, kept: 0, missed: 2, work: 3, started: 1 };
  assert.deepEqual(weekInReviewLines(counts, false), [
    "1 update posted",
    "2 promises missed",
    "3 pieces of work accepted",
    "1 new project",
  ]);
  assert.deepEqual(weekInReviewLines(counts, true), [
    "at least 1 update posted",
    "at least 2 promises missed",
    "at least 3 pieces of work accepted",
    "1 new project",
  ]);
});
