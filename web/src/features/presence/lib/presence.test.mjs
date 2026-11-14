import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLivePresenceEvent,
  PRESENCE_IDLE_TIMEOUT_MS,
  PRESENCE_TTL_MS,
  prunePresenceState,
  resolveAutomaticPresenceStatus,
} from "./presence.ts";

/**
 * Live kind:20001 events are self-signed: the subject is the event author,
 * never a p tag (a client could forge one to spoof another user).
 */

test("parseLivePresenceEvent takes the subject from the event author", () => {
  const parsed = parseLivePresenceEvent({
    pubkey: "AA".repeat(32),
    content: "online",
  });
  assert.deepEqual(parsed, { pubkey: "aa".repeat(32), status: "online" });
});

test("parseLivePresenceEvent accepts only real statuses", () => {
  for (const content of ["", "online ", "Online", "busy", "invisible"]) {
    assert.equal(
      parseLivePresenceEvent({ pubkey: "aa", content }),
      null,
      `"${content}" is not a status`,
    );
  }
  assert.equal(
    parseLivePresenceEvent({ pubkey: "aa", content: "away" })?.status,
    "away",
  );
  assert.equal(
    parseLivePresenceEvent({ pubkey: "aa", content: "offline" })?.status,
    "offline",
  );
});

test("presence expires after three heartbeat windows", () => {
  // The local TTL is what clears a crashed client's dot between prune ticks.
  assert.equal(PRESENCE_TTL_MS, 3 * 60_000);
});

test("away is idle-at-the-machine, not an unfocused window", () => {
  const now = 1_000_000;
  assert.equal(
    resolveAutomaticPresenceStatus(null, now, now),
    "online",
    "just active",
  );
  assert.equal(
    resolveAutomaticPresenceStatus(
      null,
      now - PRESENCE_IDLE_TIMEOUT_MS + 1,
      now,
    ),
    "online",
    "just inside the idle window",
  );
  assert.equal(
    resolveAutomaticPresenceStatus(null, now - PRESENCE_IDLE_TIMEOUT_MS, now),
    "away",
    "at the idle window it goes away",
  );
  assert.equal(resolveAutomaticPresenceStatus(60 * 10, now, now), "away");
  assert.equal(resolveAutomaticPresenceStatus(30, now, now), "online");
});

test("prunePresenceState drops expired observations and keeps its reference when idle", () => {
  const now = 10_000;
  const state = {
    aa: { status: "online", expiresAt: now + 1 },
    bb: { status: "away", expiresAt: now - 1 },
  };
  const pruned = prunePresenceState(state, now);
  assert.deepEqual(Object.keys(pruned), ["aa"]);
  assert.equal(
    prunePresenceState(pruned, now),
    pruned,
    "no change, same reference",
  );
});
