import assert from "node:assert/strict";
import { test } from "node:test";

import { firstUpdateWords, postedLine } from "./first-week.ts";

const DAY = 86_400;
const T0 = 1_800_000_000;

test("a project started today has its first update due in 7 days, counting down to 1 day", () => {
  assert.equal(firstUpdateWords(T0, T0), "Your first update is due in 7 days.");
  assert.equal(
    firstUpdateWords(T0, T0 + 3 * DAY + 100),
    "Your first update is due in 4 days.",
  );
  assert.equal(
    firstUpdateWords(T0, T0 + 6 * DAY),
    "Your first update is due in 1 day.",
  );
});

test("from the seventh day the first update is due now, and a clock before the start does not push it out", () => {
  assert.equal(
    firstUpdateWords(T0, T0 + 7 * DAY),
    "Your first update is due now.",
  );
  assert.equal(
    firstUpdateWords(T0, T0 + 90 * DAY),
    "Your first update is due now.",
  );
  assert.equal(
    firstUpdateWords(T0, T0 - 5 * DAY),
    "Your first update is due in 7 days.",
  );
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

test("the first-week card does not say when the first update is due while the welcome card, which says it, is on the page", async () => {
  const { firstWeekDueLine } = await import("./first-week.ts");
  const started = 1_000_000;
  assert.equal(
    firstWeekDueLine(started, started, false),
    "Your first update is due in 7 days. A few lines are enough.",
  );
  assert.equal(
    firstWeekDueLine(started, started, true),
    "A few lines are enough.",
  );
});
