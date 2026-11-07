import assert from "node:assert/strict";
import test from "node:test";

import {
  createTypingThrottle,
  parseTypingEvent,
  pruneTypingState,
  TYPING_INDICATOR_TTL_MS,
  TYPING_SEND_INTERVAL_MS,
  typingStateKey,
  typingSummaryLabel,
} from "./typing.ts";

/**
 * The throttle is what keeps typing broadcasts off the per-keystroke path.
 * Mutation check: if `shouldSend` stops gating on the interval (always
 * returns true), "the throttle holds for one interval" fails.
 */

test("the throttle holds for one interval", () => {
  let now = 0;
  const throttle = createTypingThrottle(TYPING_SEND_INTERVAL_MS, () => now);

  assert.equal(throttle.shouldSend(), true, "first call sends");
  now = 1_000;
  assert.equal(throttle.shouldSend(), false, "1s later is too soon");
  now = TYPING_SEND_INTERVAL_MS - 1;
  assert.equal(throttle.shouldSend(), false, "just inside the interval");
  now = TYPING_SEND_INTERVAL_MS;
  assert.equal(throttle.shouldSend(), true, "at the interval it sends again");
  now = TYPING_SEND_INTERVAL_MS + 500;
  assert.equal(throttle.shouldSend(), false, "and then holds again");
});

test("reset forgets the last send (channel switch)", () => {
  let now = 0;
  const throttle = createTypingThrottle(TYPING_SEND_INTERVAL_MS, () => now);
  assert.equal(throttle.shouldSend(), true);
  now = 10;
  assert.equal(throttle.shouldSend(), false);
  throttle.reset();
  assert.equal(throttle.shouldSend(), true, "after reset the next call sends");
});

const baseEvent = (overrides = {}) => ({
  kind: 20002,
  pubkey: "AA".repeat(32),
  created_at: 1_000,
  tags: [["h", "chan-1"]],
  ...overrides,
});

test("parseTypingEvent accepts a live typing event and lowercases the pubkey", () => {
  const parsed = parseTypingEvent(baseEvent(), {
    channelId: "chan-1",
    selfPubkey: null,
    now: 1_000 * 1_000,
  });
  assert.deepEqual(parsed, { pubkey: "aa".repeat(32), threadHeadId: null });
});

test("parseTypingEvent keeps the thread scope from the e tag", () => {
  const parsed = parseTypingEvent(
    baseEvent({
      tags: [
        ["h", "chan-1"],
        ["e", "root-1"],
      ],
    }),
    { channelId: "chan-1", selfPubkey: null, now: 1_000 * 1_000 },
  );
  assert.equal(parsed?.threadHeadId, "root-1");
});

test("parseTypingEvent rejects the wrong channel, the viewer, and stale events", () => {
  const now = 1_000 * 1_000;
  assert.equal(
    parseTypingEvent(baseEvent({ tags: [["h", "other"]] }), {
      channelId: "chan-1",
      selfPubkey: null,
      now,
    }),
    null,
    "another channel's typing is not ours",
  );
  assert.equal(
    parseTypingEvent(baseEvent(), {
      channelId: "chan-1",
      selfPubkey: "aa".repeat(32),
      now,
    }),
    null,
    "the viewer's own typing never renders",
  );
  assert.equal(
    parseTypingEvent(
      baseEvent({ created_at: 1_000 - TYPING_INDICATOR_TTL_MS / 1_000 }),
      { channelId: "chan-1", selfPubkey: null, now },
    ),
    null,
    "an expired event must not resurrect old state",
  );
  assert.equal(
    parseTypingEvent(baseEvent({ kind: 9 }), {
      channelId: "chan-1",
      selfPubkey: null,
      now,
    }),
    null,
    "only kind:20002 is a typing event",
  );
});

test("pruneTypingState drops expired typers and keeps its reference when idle", () => {
  const now = 10_000;
  const state = {
    [typingStateKey("aa", null)]: {
      pubkey: "aa",
      threadHeadId: null,
      firstSeenAt: 1,
      expiresAt: now + 1,
    },
    [typingStateKey("bb", "root-1")]: {
      pubkey: "bb",
      threadHeadId: "root-1",
      firstSeenAt: 2,
      expiresAt: now - 1,
    },
  };
  const pruned = pruneTypingState(state, now);
  assert.deepEqual(Object.keys(pruned), [typingStateKey("aa", null)]);
  assert.equal(
    pruneTypingState(pruned, now),
    pruned,
    "no change, same reference",
  );
});

test("typingSummaryLabel reads as plain speech", () => {
  assert.equal(typingSummaryLabel([]), null);
  assert.equal(typingSummaryLabel(["Alice"]), "Alice is typing…");
  assert.equal(
    typingSummaryLabel(["Alice", "Bob"]),
    "Alice and Bob are typing…",
  );
  assert.equal(
    typingSummaryLabel(["Alice", "Bob", "Carol"]),
    "3 people are typing…",
  );
  assert.equal(
    typingSummaryLabel(["Alice", "Alice"]),
    "Alice is typing…",
    "one person typing in two threads is one name",
  );
});
