// Capability announcements are stored forever (kind 44010 is not replaceable),
// so they are published on change plus a slow keepalive.
// Run with: node --experimental-strip-types --test src/features/fleet/lib/heartbeat.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_WINDOW_MS,
  shouldPublishAnnouncement,
} from "./heartbeat.ts";

const last = { fingerprint: "available", atMs: 1_000_000 };

test("the first announcement is always published", () => {
  assert.equal(shouldPublishAnnouncement(null, "available", 0), true);
});

test("an unchanged announcement is not republished inside the interval", () => {
  for (const elapsed of [0, 60_000, 5 * 60_000, HEARTBEAT_INTERVAL_MS - 1]) {
    assert.equal(
      shouldPublishAnnouncement(last, "available", last.atMs + elapsed),
      false,
      `${elapsed}ms`,
    );
  }
});

test("a change is published immediately", () => {
  assert.equal(shouldPublishAnnouncement(last, "busy", last.atMs + 1), true);
});

test("the keepalive fires once the interval has passed", () => {
  assert.equal(
    shouldPublishAnnouncement(
      last,
      "available",
      last.atMs + HEARTBEAT_INTERVAL_MS,
    ),
    true,
  );
});

test("a day of idling writes 144 rows, not 1,440", () => {
  let state = null;
  let published = 0;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const nowMs = minute * 60_000; // the timer looks once a minute
    if (shouldPublishAnnouncement(state, "available", nowMs)) {
      published += 1;
      state = { fingerprint: "available", atMs: nowMs };
    }
  }
  assert.equal(published, 144);
});

test("liveness readers tolerate one full interval of silence", () => {
  assert.ok(LIVENESS_WINDOW_MS > HEARTBEAT_INTERVAL_MS);
});

test("production wiring: the roster's liveness window and the agent share these constants", () => {
  const roster = readFileSync(
    new URL("../use-agent-roster.ts", import.meta.url),
    "utf8",
  );
  assert.match(roster, /LIVENESS_WINDOW_MS/);
  assert.doesNotMatch(roster, /const LIVENESS_WINDOW_MS = 180_000/);
  const agent = readFileSync(
    new URL("../browser-agent.ts", import.meta.url),
    "utf8",
  );
  assert.match(agent, /shouldPublishAnnouncement\(/);
  assert.doesNotMatch(agent, /HEARTBEAT_MS = 60_000/);
});
