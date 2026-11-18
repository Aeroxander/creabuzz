import assert from "node:assert/strict";
import { test } from "node:test";

import { updateDayTally, updateDayWords } from "./update-day-tally.ts";

// Wednesday 2026-11-18 12:00 local time, so "the day has come round" is the same in every time zone's calendar day.
const NOW = Math.floor(new Date(2026, 10, 18, 12, 0, 0).getTime() / 1000);
const DAY = 86_400;
const FOUNDER = "f".repeat(64);
const MATE = "a".repeat(64);
const STRANGER = "c".repeat(64);
const WEDNESDAY = 3;
const project = (id, startedDaysAgo, updates, extra = {}) => ({
  record: {
    id,
    author: FOUNDER,
    startedAt: NOW - startedDaysAgo * DAY,
    team: [{ pubkey: MATE }],
    ...extra,
  },
  updates: updates.map(([author, daysAgo]) => ({
    author,
    createdAt: NOW - daysAgo * DAY,
  })),
});
const tally = (launches, weekday = () => WEDNESDAY) => {
  const out = updateDayTally(launches, NOW, weekday);
  return {
    posted: out.posted.map((l) => l.record.id),
    due: out.due.map((l) => l.record.id),
  };
};

test("a project that posted since its update day came round has posted; one that has not is due", () => {
  assert.deepEqual(
    tally([
      project("today", 40, [[FOUNDER, 0.1]]),
      project("lastweek", 40, [[FOUNDER, 8]]),
      project("never", 40, []),
    ]),
    { posted: ["today"], due: ["lastweek", "never"] },
  );
});

test("a project's own update day decides: the day has not come round yet, so last week's update still settles it", () => {
  // Thursday is tomorrow: the most recent Thursday was six days ago, and an update eight days ago is older than that.
  // An update three days ago is after that Thursday: posted.
  assert.deepEqual(
    tally(
      [project("a", 40, [[FOUNDER, 3]]), project("b", 40, [[FOUNDER, 8]])],
      () => 4,
    ),
    { posted: ["a"], due: ["b"] },
  );
});

test("a project under a week old with no update is neither: its first update is not due yet", () => {
  assert.deepEqual(tally([project("new", 2, []), project("week", 8, [])]), {
    posted: [],
    due: ["week"],
  });
});

test("only the team's own updates count; an unlisted project is left out", () => {
  assert.deepEqual(
    tally([
      project("mate", 40, [[MATE, 0.1]]),
      project("stranger", 40, [[STRANGER, 0.1]]),
      project("hidden", 40, [[FOUNDER, 0.1]], { listing: "unlisted" }),
    ]),
    { posted: ["mate"], due: ["stranger"] },
  );
});

test("an update dated ahead of now does not settle the week", () => {
  assert.deepEqual(tally([project("ahead", 40, [[FOUNDER, -2]])]), {
    posted: [],
    due: ["ahead"],
  });
});

test("the words are neutral and exact", () => {
  assert.equal(updateDayWords(4, 3), "4 projects have posted, 3 are due.");
  assert.equal(updateDayWords(1, 1), "1 project has posted, 1 is due.");
  assert.equal(updateDayWords(2, 0), "2 projects have posted, none are due.");
  assert.equal(updateDayWords(0, 3), "No project has posted yet, 3 are due.");
  assert.equal(updateDayWords(0, 0), null);
  assert.doesNotMatch(updateDayWords(4, 3), /late|miss|overdue|behind/i);
});
