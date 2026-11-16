import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIRST_WEEK_HEADING,
  FIRST_WEEK_LINE,
  FIRST_WEEK_STEPS,
  FIRST_WEEK_WORDS,
  firstWeekDoneLine,
  firstWeekForm,
  firstWeekProgress,
  postedLine,
  progressWords,
  youSaidWords,
} from "./first-week.ts";
import { soloWinRefusal } from "./solo-win.ts";
import { confirmRule, founderWorksAlone } from "./task-checks.ts";

const DAY = 86_400;
// Monday 2026-11-16, local noon: far from a day boundary in any time zone.
const NOW = Math.floor(new Date(2026, 10, 16, 12).getTime() / 1000);

test("the card says its heading and one line, to one person", () => {
  assert.equal(FIRST_WEEK_HEADING, "Your first week");
  assert.equal(
    FIRST_WEEK_LINE,
    "Three steps. You can do all of them on your own.",
  );
  assert.deepEqual(
    FIRST_WEEK_STEPS.map((step) => step.title),
    ["Say your goal", "Get one thing done", "Post week one"],
  );
  assert.equal(FIRST_WEEK_WORDS.addWork, "Add what you did");
  assert.equal(FIRST_WEEK_WORDS.post, "Post this week's update");
  assert.equal(
    youSaidWords("Wrote the first page"),
    "You said you would: Wrote the first page.",
  );
});

test("the goal is ticked from the start, and a step not read is never ticked", () => {
  assert.deepEqual(firstWeekProgress({ worksDone: null, updates: null }), {
    done: { goal: true, work: false, post: false },
    count: 1,
  });
  assert.equal(firstWeekProgress({ worksDone: 0, updates: 0 }).count, 1);
  assert.equal(progressWords(1), "1 of 3");
});

test("one piece of work done ticks step two, the first update ticks step three: 3 of 3", () => {
  const two = firstWeekProgress({ worksDone: 1, updates: 0 });
  assert.equal(two.count, 2);
  assert.equal(two.done.work, true);
  const three = firstWeekProgress({ worksDone: 1, updates: 1 });
  assert.equal(three.count, 3);
  assert.equal(progressWords(three.count), "3 of 3");
});

test("every step can be done by a founder alone: no step needs another person, and the real rules agree", () => {
  assert.ok(FIRST_WEEK_STEPS.every((step) => step.needs === "founder"));
  const founder = "f".repeat(64);
  // Step two: the solo flow is open to a founder with nobody else on the project...
  const who = {
    viewer: founder,
    founder,
    team: new Set([founder]),
    viewerIsAgent: false,
  };
  assert.equal(soloWinRefusal(who), null);
  assert.equal(soloWinRefusal(who, { start: "full" }), null);
  // ...and the founder's own check of their own work is allowed by the same rule the task rows use.
  const task = {
    helper: founder,
    helperAgent: null,
    coordinate: `37001:${founder}:p`,
  };
  assert.equal(founderWorksAlone(task, who.team), true);
  assert.deepEqual(confirmRule(task, who.team, founder), {
    may: true,
    alone: true,
  });
  // With a teammate it is not the solo flow any more: the full form stays.
  const withTeam = { ...who, team: new Set([founder, "a".repeat(64)]) };
  assert.equal(soloWinRefusal(withTeam), "not-alone");
});

test("the card is the three steps with no update, one line after the first, and gone after that", () => {
  assert.equal(
    firstWeekForm({ updates: 0, lastUpdateAt: null, now: NOW }),
    "steps",
  );
  // A read that did not finish never tells a founder with updates that they have none.
  assert.equal(
    firstWeekForm({ updates: null, lastUpdateAt: null, now: NOW }),
    "gone",
  );
  assert.equal(
    firstWeekForm({ updates: 1, lastUpdateAt: NOW - 2 * DAY, now: NOW }),
    "done",
  );
  // The next update is late: the project's own update card says so, this one gives way.
  assert.equal(
    firstWeekForm({ updates: 1, lastUpdateAt: NOW - 9 * DAY, now: NOW }),
    "gone",
  );
  assert.equal(
    firstWeekForm({ updates: 2, lastUpdateAt: NOW, now: NOW }),
    "gone",
  );
});

test("after the first update the line says when the next one is due", () => {
  const line = firstWeekDoneLine(NOW, NOW, "en-US");
  assert.equal(line, "First week done. Next update: Mon, Nov 23.");
  assert.equal(
    firstWeekDoneLine(NOW - 3 * DAY, NOW, "en-US"),
    "First week done. Next update: Fri, Nov 20.",
  );
  // Late, or nothing posted: no such line.
  assert.equal(firstWeekDoneLine(NOW - 9 * DAY, NOW, "en-US"), null);
});

test("a run of weeks is stated only once two promises are answered, as on the share picture", () => {
  assert.equal(
    postedLine({ streak: 3, answered: 2 }),
    "That's 3 weeks in a row. Keep it going next week.",
  );
  // Three weeks in a row but one answered promise: the picture states no run, so the sentence does not either.
  assert.equal(
    postedLine({ streak: 3, answered: 1 }),
    "It's on your project's record. Post again next week to keep it going.",
  );
  assert.equal(
    postedLine({ streak: 4, answered: 0 }),
    "It's on your project's record. Post again next week to keep it going.",
  );
});

test("the first week says week one, and an unread record claims nothing", () => {
  assert.equal(
    postedLine({ streak: 1, answered: 5 }),
    "That's week one. Post again next week and your run begins.",
  );
  assert.equal(
    postedLine(null),
    "It's on your project's record for everyone to read.",
  );
});
