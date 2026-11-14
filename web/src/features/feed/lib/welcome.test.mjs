import assert from "node:assert/strict";
import test from "node:test";

import { markWelcomeSeen, welcomePicks, welcomeSeen } from "./welcome.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;
const store = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
};

test("the welcome is seen once per account and server, and a browser that keeps nothing shows it again", () => {
  const s = store();
  assert.equal(welcomeSeen(s, "wss://a", "AB"), false);
  assert.equal(markWelcomeSeen(s, "wss://a", "AB"), true);
  assert.equal(welcomeSeen(s, "wss://a", "ab"), true);
  // Another account, or the same account on another server, has not seen it.
  assert.equal(welcomeSeen(s, "wss://a", "cd"), false);
  assert.equal(welcomeSeen(s, "wss://b", "ab"), false);
  assert.equal(markWelcomeSeen(null, "wss://a", "ab"), false);
  const broken = {
    getItem: () => {
      throw new Error("no");
    },
    setItem: () => {
      throw new Error("no");
    },
  };
  assert.equal(welcomeSeen(broken, "wss://a", "ab"), false);
  assert.equal(markWelcomeSeen(broken, "wss://a", "ab"), false);
});

const project = (id, author, startedAt, days = []) => ({
  record: { id, author, eventId: id.padEnd(64, "0"), startedAt, team: [] },
  updates: days.map((ago) => ({ author, createdAt: NOW - ago * DAY - 60 })),
});

test("the projects offered are the active ones first, then the newest; never the reader's own, never one twice", () => {
  const list = [
    project("old-quiet", "a", NOW - 90 * DAY),
    project("new-quiet", "b", NOW - DAY),
    project("busy", "c", NOW - 50 * DAY, [0, 1, 2]),
    project("some", "d", NOW - 40 * DAY, [3]),
    project("mine", "me", NOW - 10, [0, 1, 2, 3]),
    // Records dated ahead of now, and a stranger's, are no activity.
    {
      ...project("fake", "e", NOW - 80 * DAY),
      updates: [
        { author: "e", createdAt: NOW + DAY },
        { author: "x", createdAt: NOW - 60 },
      ],
    },
  ];
  assert.deepEqual(
    welcomePicks(list, NOW, "me").map((l) => l.record.id),
    ["busy", "some", "new-quiet", "fake", "old-quiet"],
  );
  assert.deepEqual(
    welcomePicks(list, NOW, "me", 2).map((l) => l.record.id),
    ["busy", "some"],
  );
});
