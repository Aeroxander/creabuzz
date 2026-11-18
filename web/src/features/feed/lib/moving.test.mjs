import assert from "node:assert/strict";
import { test } from "node:test";

import { activeDays, movingLine, movingNow } from "./moving.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;
const F = "f".repeat(64);
const MATE = "a".repeat(64);
const STRANGER = "c".repeat(64);
const launch = (id, updates, over = {}) => ({
  record: {
    id,
    author: F,
    eventId: id,
    startedAt: 1,
    team: [{ pubkey: MATE }],
    ...over,
  },
  updates,
});
const up = (author, daysAgo, offset = 0) => ({
  author,
  createdAt: NOW - daysAgo * DAY - 60 - offset,
});

test("the score is days the team posted on, not how many records: ten in an afternoon are one day", () => {
  const burst = launch(
    "burst",
    Array.from({ length: 10 }, (_, i) => up(F, 0, i)),
  );
  const steady = launch("steady", [up(F, 0), up(MATE, 2), up(F, 4)]);
  assert.equal(activeDays(burst, NOW).days, 1);
  assert.equal(activeDays(steady, NOW).days, 3);
  assert.deepEqual(
    movingNow([burst, steady], NOW).map((m) => m.launch.record.id),
    ["steady", "burst"],
  );
});

test("only the project's own people count, only the last seven days, and nothing dated ahead", () => {
  const l = launch("x", [
    up(STRANGER, 0),
    up(F, 8),
    { author: F, createdAt: NOW + 600 },
  ]);
  assert.equal(activeDays(l, NOW).days, 0);
  assert.deepEqual(movingNow([l], NOW), []);
});

test("saving the project's record again moves nothing", () => {
  const a = launch("a", [up(F, 1)]);
  const resaved = launch("b", [up(F, 3)], { startedAt: NOW, eventId: "zz" });
  assert.deepEqual(
    movingNow([resaved, a], NOW).map((m) => m.launch.record.id),
    ["a", "b"],
  );
});

test("ties go to whoever posted last, then keep one steady order", () => {
  const older = launch("b-older", [up(F, 3)]);
  const newer = launch("a-newer", [up(F, 1)]);
  const same1 = launch("m", [up(F, 2)]);
  const same2 = launch("k", [up(F, 2)]);
  assert.deepEqual(
    movingNow([older, same1, newer, same2], NOW).map((m) => m.launch.record.id),
    ["a-newer", "k", "m", "b-older"],
  );
  assert.equal(movingNow([older, newer, same1], NOW, 2).length, 2);
});

test("the line under a name says it in words", () => {
  assert.equal(movingLine({ days: 1, lastAt: NOW - 100 }, NOW), "Posted today");
  assert.equal(
    movingLine({ days: 1, lastAt: NOW - 3 * DAY }, NOW),
    "Posted this week",
  );
  assert.equal(
    movingLine({ days: 5, lastAt: NOW }, NOW),
    "Posted on 5 of the last 7 days",
  );
});
