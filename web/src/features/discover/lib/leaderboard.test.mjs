import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardOrder,
  keptWords,
  projectScore,
  streakWords,
} from "./leaderboard.ts";

const DAY = 86_400;
const WEEK = 7 * DAY;
// A Wednesday noon (UTC), so "this week" and "last week" are whole weeks away from the edges.
const NOW = 1_800_000_000 - (1_800_000_000 % WEEK) + 6 * DAY + DAY / 2;
const F = "f".repeat(64);
const MATE = "a".repeat(64);
const STRANGER = "c".repeat(64);
const project = {
  coordinate: `37001:${F}:nebula`,
  founder: F,
  team: new Set([F, MATE]),
  startedAt: NOW - 20 * WEEK,
};
let n = 0;
const up = (author, at, over = {}) => {
  n += 1;
  return {
    id: `u${n}`.padEnd(64, "0"),
    author,
    createdAt: at,
    weekly: true,
    ...over,
  };
};
const score = (updates, found = new Set(), p = project) =>
  projectScore(p, updates, found, NOW);

test("a streak is weeks in a row with an update from the project's own people", () => {
  const three = [up(F, NOW - DAY), up(MATE, NOW - WEEK), up(F, NOW - 2 * WEEK)];
  assert.equal(score(three).streak, 3);
  // A gap ends it; ten updates in one week are one week.
  assert.equal(score([up(F, NOW - DAY), up(F, NOW - 3 * WEEK)]).streak, 1);
  assert.equal(
    score(Array.from({ length: 10 }, (_, i) => up(F, NOW - i * 60))).streak,
    1,
  );
  // A stranger's record about the project earns nothing.
  assert.equal(score([up(STRANGER, NOW - DAY)]).streak, 0);
  assert.equal(streakWords(3), "3 weeks in a row");
  assert.equal(streakWords(1), "Posted this week");
  assert.equal(streakWords(0), null);
});

test("a record dated ahead, or from before the project was first published, cannot earn a streak", () => {
  // Dated next week and the week after: not counted, however the founder signs them.
  assert.equal(score([up(F, NOW + WEEK), up(F, NOW + 2 * WEEK)]).streak, 0);
  assert.equal(score([up(F, NOW + 600)]).streak, 0);
  // A project first published three days ago with "updates" dated across the six weeks before it.
  const young = { ...project, startedAt: NOW - 3 * DAY };
  const backdated = [
    up(F, NOW - DAY),
    ...Array.from({ length: 6 }, (_, i) => up(F, NOW - (i + 1) * WEEK)),
  ];
  assert.equal(score(backdated, new Set(), young).streak, 1);
  assert.equal(score(backdated, new Set(), young).days, 1);
});

test("kept promises are the founder's answers, counted as kept of answered", () => {
  const first = up(F, NOW - 2 * WEEK, {
    promises: [
      { index: 0, text: "A" },
      { index: 1, text: "B" },
      { index: 2, text: "C" },
    ],
  });
  const second = up(F, NOW - WEEK, {
    marks: [
      { promiseId: `${first.id}:0`, state: "done", note: "" },
      { promiseId: `${first.id}:1`, state: "not-done", note: "" },
    ],
  });
  // A team member cannot answer the founder's promises.
  const mates = up(MATE, NOW - DAY, {
    marks: [{ promiseId: `${first.id}:2`, state: "done", note: "" }],
  });
  const got = score([first, second, mates]);
  assert.equal(got.kept, 1);
  assert.equal(got.answered, 2);
  assert.equal(keptWords(got), "1 of 2 promises kept");
  assert.equal(keptWords({ kept: 0, answered: 0 }), null);
  assert.equal(keptWords({ kept: 1, answered: 1 }), "1 of 1 promise kept");
});

test("open help is the requests the team has not marked as found", () => {
  const a = up(F, NOW - 2 * DAY, { asks: true });
  const b = up(MATE, NOW - DAY, { asks: true });
  assert.equal(score([a, b]).openHelp, 2);
  const closed = score([a, b], new Set([b.id]));
  assert.equal(closed.openHelp, 1);
  assert.equal(closed.askedAt, a.createdAt);
});

test("each tab lists and orders by its own measure, and saving a record again moves nothing", () => {
  const s = (coordinate, over) => ({
    coordinate,
    streak: 0,
    kept: 0,
    answered: 0,
    openHelp: 0,
    askedAt: 0,
    days: 0,
    startedAt: 0,
    ...over,
  });
  const scores = [
    s("a", { days: 2, streak: 5, kept: 3, answered: 5, startedAt: 10 }),
    s("b", { days: 5, streak: 1, kept: 3, answered: 3, startedAt: 30 }),
    s("c", { openHelp: 1, askedAt: 50, startedAt: 20 }),
    s("d", { openHelp: 2, askedAt: 90, days: 2, streak: 6 }),
  ];
  const ids = (tab) => boardOrder(scores, tab).map((x) => x.coordinate);
  assert.deepEqual(ids("moving"), ["b", "d", "a"]);
  assert.deepEqual(ids("new"), ["b", "c", "a", "d"]);
  // Same number kept: the one with fewer misses first.
  assert.deepEqual(ids("kept"), ["b", "a"]);
  assert.deepEqual(ids("help"), ["d", "c"]);
});

test("a record dated ahead of now adds no day, no request and no kept promise", () => {
  const ahead = [
    up(F, NOW + DAY, { asks: true }),
    up(F, NOW + 2 * DAY, { asks: true }),
  ];
  const s = score(ahead);
  assert.equal(s.days, 0);
  assert.equal(s.openHelp, 0);
  assert.equal(s.streak, 0);
  assert.equal(boardOrder([s], "moving").length, 0);
});
