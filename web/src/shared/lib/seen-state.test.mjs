import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readSeen, seenKey, writeSeen } from "./seen-state.ts";

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    data,
  };
};
const A = "a".repeat(64);
const B = "b".repeat(64);

test("the time is kept for one account on one server: another account, or another server, starts unread", () => {
  const store = memory();
  assert.equal(writeSeen(store, "wss://one", A, 500), true);
  assert.equal(readSeen(store, "wss://one", A), 500);
  assert.equal(readSeen(store, "wss://one", B), 0);
  assert.equal(readSeen(store, "wss://two", A), 0);
  assert.notEqual(seenKey("wss://one", A), seenKey("wss://two", A));
});

test("the old browser-wide note is never taken for this account's; the old per-account note is a starting point", () => {
  const store = memory({
    "buzz.notifications.seen": "999999999999",
    [`buzz.social.notifications.seen.${A}`]: "700",
  });
  assert.equal(readSeen(store, "wss://one", A), 700);
  assert.equal(readSeen(store, "wss://one", B), 0);
});

test("it never moves backwards, and a browser that refuses is survived", () => {
  const store = memory();
  writeSeen(store, "s", A, 900);
  writeSeen(store, "s", A, 400);
  assert.equal(readSeen(store, "s", A), 900);
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readSeen(refusing, "s", A), 0);
  assert.equal(writeSeen(refusing, "s", A, 1), false);
  assert.equal(readSeen(null, "s", A), 0);
});

test("both bells read and write this one time", () => {
  const rooms = readFileSync(
    new URL(
      "../../features/notifications/use-notifications.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const timeline = readFileSync(
    new URL("../../features/social/lib/notifications.ts", import.meta.url),
    "utf8",
  );
  for (const source of [rooms, timeline]) {
    assert.match(source, /readSeen\(/);
    assert.match(source, /writeSeen\(/);
    assert.doesNotMatch(source, /"buzz\.notifications\.seen"/);
    assert.doesNotMatch(source, /buzz\.social\.notifications\.seen/);
  }
});
