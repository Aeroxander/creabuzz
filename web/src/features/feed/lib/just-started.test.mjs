import assert from "node:assert/strict";
import { test } from "node:test";

import { JUST_STARTED_SHOWN, justStarted } from "./just-started.ts";

const NOW = 10_000_000;
const DAY = 86_400;
const FOUNDER = "f".repeat(64);
const MATE = "a".repeat(64);
const ME = "c".repeat(64);
const project = (id, ageDays, extra = {}, updates = []) => ({
  record: {
    id,
    author: FOUNDER,
    eventId: `ev-${id}`,
    startedAt: NOW - Math.round(ageDays * DAY),
    team: [{ pubkey: MATE }],
    ...extra,
  },
  updates,
});
const coordinate = (record) => `${record.author}:${record.id}`;
const pick = (launches, input = {}) =>
  justStarted(launches, {
    now: NOW,
    me: null,
    announced: new Set(),
    coordinate,
    ...input,
  }).map((l) => l.record.id);

test("a project under seven days old with no update is just started, newest first", () => {
  assert.deepEqual(
    pick([project("old", 6.9), project("new", 0.1), project("mid", 3)]),
    ["new", "mid", "old"],
  );
  assert.deepEqual(pick([project("week", 7), project("older", 30)]), []);
});

test("an update by the project's own team ends it; someone else's does not", () => {
  const byFounder = project("a", 1, {}, [{ author: FOUNDER }]);
  const byMate = project("b", 1, {}, [{ author: MATE }]);
  const byStranger = project("c", 1, {}, [{ author: ME }]);
  assert.deepEqual(pick([byFounder, byMate, byStranger]), ["c"]);
});

test("not the reader's own, not unlisted, not one the feed already announces", () => {
  const mine = project("mine", 1, { author: ME });
  const hidden = project("hidden", 1, { listing: "unlisted" });
  const seen = project("seen", 1);
  const open = project("open", 1);
  assert.deepEqual(
    pick([mine, hidden, seen, open], {
      me: ME,
      announced: new Set([coordinate(seen.record)]),
    }),
    ["open"],
  );
});

test("a start dated a few minutes ahead counts as now; one dated far ahead does not", () => {
  assert.deepEqual(pick([project("soon", -0.005)]), ["soon"]);
  assert.deepEqual(pick([project("far", -1)]), []);
});

test("the strip is short", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    project(`p${i}`, 1 + i / 100),
  );
  assert.equal(pick(many).length, JUST_STARTED_SHOWN);
});
