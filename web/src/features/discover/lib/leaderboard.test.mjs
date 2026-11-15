import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardOrder,
  isRealUpdate,
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
    missed: 0,
    unanswered: 0,
    rankStreak: 0,
    lastRealAt: 0,
    line: "",
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

// A project whose founder made three promises and, a week later, answered them as given, with a weekly update in each of
// the weeks around them.
function answered(states, extra = []) {
  const first = up(F, NOW - 3 * WEEK, {
    promises: states.map((_, index) => ({ index, text: `P${index}` })),
  });
  const second = up(F, NOW - 2 * WEEK, {
    marks: states.map((state, index) => ({
      promiseId: `${first.id}:${index}`,
      state,
      note: "",
    })),
  });
  return [
    first,
    second,
    up(F, NOW - WEEK, { line: "Shipped the signup page this week." }),
    up(F, NOW - DAY, { line: "Fixed the login bug and wrote it up." }),
    ...extra,
  ];
}

test("a run of weeks ranks only when it is paired with answered promises, kept at least as often as missed", () => {
  // Four weeks in a row, two answered and both kept: the run counts.
  const good = score(answered(["done", "done"]));
  assert.equal(good.streak, 4);
  assert.equal(good.rankStreak, 4);
  // The same four weeks with one promise answered: a run with almost no record behind it ranks as none.
  assert.equal(score(answered(["done"])).streak, 4);
  assert.equal(score(answered(["done"])).rankStreak, 0);
  // Posting every week and answering nothing.
  const quiet = Array.from({ length: 6 }, (_, i) =>
    up(F, NOW - i * WEEK - 60, { line: "Still working on it all." }),
  );
  assert.equal(score(quiet).streak, 6);
  assert.equal(score(quiet).rankStreak, 0);
  // More missed than kept: the run is real but does not rank.
  const bad = score(answered(["done", "not-done", "not-done"]));
  assert.equal(bad.streak, 4);
  assert.equal(bad.missed, 2);
  assert.equal(bad.rankStreak, 0);
  // Promises a later update left unanswered count against the run as well.
  const left = answered(["done", "done"]);
  left[0].promises.push({ index: 2, text: "P2" });
  assert.equal(score(left).unanswered, 1);
  assert.equal(score(left).rankStreak, 4);
  left[0].promises.push({ index: 3, text: "P3" }, { index: 4, text: "P4" });
  assert.equal(score(left).unanswered, 3);
  assert.equal(score(left).rankStreak, 0);
});

test("only a weekly update that says something is real, and a bare one cannot place a project", () => {
  assert.equal(isRealUpdate(up(F, NOW, { line: "Done." })), false);
  assert.equal(isRealUpdate(up(F, NOW, {})), false);
  assert.equal(
    isRealUpdate(up(F, NOW, { line: "Shipped the signup page this week." })),
    true,
  );
  assert.equal(
    isRealUpdate(up(F, NOW, { promises: [{ index: 0, text: "A" }] })),
    true,
  );
  assert.equal(
    isRealUpdate(
      up(F, NOW, {
        marks: [{ promiseId: `${"a".repeat(64)}:0`, state: "done" }],
      }),
    ),
    true,
  );
  // Not weekly: a help request or a free post is not a weekly update.
  assert.equal(
    isRealUpdate(
      up(F, NOW, { weekly: false, line: "Shipped the signup page this week." }),
    ),
    false,
  );
  const trivial = score([up(F, NOW - DAY, { line: "ok" })]);
  assert.equal(trivial.lastRealAt, 0);
  const said = up(F, NOW - 2 * DAY, { line: "Shipped the signup page today." });
  assert.equal(
    score([said, up(F, NOW - DAY, { line: "ok" })]).lastRealAt,
    said.createdAt,
  );
});

test("a card's line is the stored one line of the newest weekly update, and a stranger's never shows", () => {
  const older = up(F, NOW - 2 * DAY, { line: "Older words." });
  const newer = up(MATE, NOW - DAY, { line: "  Newer words from the team.  " });
  const stranger = up(STRANGER, NOW - 60, { line: "Buy my coin now." });
  const ahead = up(F, NOW + DAY, { line: "From the future." });
  const free = up(F, NOW - 30, { weekly: false, line: "A free post." });
  assert.equal(
    score([older, newer, stranger, ahead, free]).line,
    "Newer words from the team.",
  );
  assert.equal(score([up(F, NOW - DAY)]).line, "");
});

test("Most reliable: paired run first, then kept, then fewer misses, then the newest real update; money has no place in it", () => {
  const s = (coordinate, over) => ({
    coordinate,
    streak: 0,
    kept: 0,
    answered: 0,
    missed: 0,
    unanswered: 0,
    rankStreak: 0,
    lastRealAt: 100,
    line: "",
    openHelp: 0,
    askedAt: 0,
    days: 0,
    startedAt: 0,
    ...over,
  });
  const scores = [
    // Posts every week for ten weeks and answers nothing: ranks on recency alone.
    s("gamer", { streak: 10, lastRealAt: 900 }),
    s("long", {
      streak: 6,
      rankStreak: 6,
      kept: 4,
      answered: 5,
      missed: 1,
      lastRealAt: 200,
    }),
    s("longer", {
      streak: 6,
      rankStreak: 6,
      kept: 5,
      answered: 5,
      lastRealAt: 150,
    }),
    s("longest", {
      streak: 8,
      rankStreak: 8,
      kept: 2,
      answered: 2,
      lastRealAt: 120,
    }),
    // Same run and kept as "long", one fewer miss.
    s("tidy", {
      streak: 6,
      rankStreak: 6,
      kept: 4,
      answered: 4,
      lastRealAt: 100,
    }),
    // Same everything as "tidy", newer.
    s("tidy-new", {
      streak: 6,
      rankStreak: 6,
      kept: 4,
      answered: 4,
      lastRealAt: 300,
    }),
    s("new-real", { lastRealAt: 800 }),
    // No real update: not in the list at all.
    s("empty", { streak: 5, lastRealAt: 0 }),
  ];
  assert.deepEqual(
    boardOrder(scores, "reliable").map((x) => x.coordinate),
    ["longest", "longer", "tidy-new", "tidy", "long", "gamer", "new-real"],
  );
});
