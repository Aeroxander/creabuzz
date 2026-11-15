import assert from "node:assert/strict";
import { test } from "node:test";

import { streakAtRisk, streakRiskWords, weekStart } from "./streak-risk.ts";

const DAY = 86_400;
// Wednesday 2026-11-18 12:00 UTC. That week began on Monday 2026-11-16 00:00 UTC.
const NOW = Date.UTC(2026, 10, 18, 12) / 1000;
const MONDAY = Date.UTC(2026, 10, 16) / 1000;

test("a week starts on Monday at midnight UTC", () => {
  assert.equal(weekStart(NOW), MONDAY);
  assert.equal(weekStart(MONDAY), MONDAY);
  assert.equal(weekStart(MONDAY - 1), MONDAY - 7 * DAY);
  assert.equal(weekStart(MONDAY + 7 * DAY - 1), MONDAY);
});

test("a run is at risk only when its update is due and nothing is posted yet this week", () => {
  const base = { streak: 3, lastUpdateAt: MONDAY - DAY, due: true, now: NOW };
  assert.equal(streakAtRisk(base), 3);
  // Posted this week: safe, even though the update day has not come round.
  assert.equal(streakAtRisk({ ...base, lastUpdateAt: MONDAY + 60 }), null);
  // The update day has not come: not at risk yet.
  assert.equal(streakAtRisk({ ...base, due: false }), null);
  // No run to lose, or none known.
  assert.equal(streakAtRisk({ ...base, streak: 1 }), null);
  assert.equal(streakAtRisk({ ...base, streak: null }), null);
  assert.equal(streakAtRisk({ ...base, lastUpdateAt: null }), null);
});

test("the words say what posting does, and nothing about not posting", () => {
  const words = streakRiskWords(3);
  assert.equal(words, "An update this week keeps your run of 3 weeks going.");
  assert.doesNotMatch(words, /lose|lost|break|broken|late|miss|risk|fail/i);
});
