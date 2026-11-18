import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POLL_EVERY_MS,
  POLL_FOR_MS,
  deadlineDelayMs,
  pollInterval,
  pollPaused,
} from "./bounded-poll.ts";

test("a screen keeps asking for fifteen minutes after someone last asked, and then stops", () => {
  const asked = 1_000_000;
  assert.equal(pollInterval(asked, asked), POLL_EVERY_MS);
  assert.equal(pollInterval(asked + POLL_FOR_MS - 1, asked), POLL_EVERY_MS);
  assert.equal(pollInterval(asked + POLL_FOR_MS, asked), false);
  assert.equal(pollInterval(asked + 10 * POLL_FOR_MS, asked), false);
  assert.equal(pollPaused(asked + POLL_FOR_MS - 1, asked), false);
  assert.equal(pollPaused(asked + POLL_FOR_MS, asked), true);
  // Asking again starts it again.
  assert.equal(
    pollInterval(asked + POLL_FOR_MS + 5, asked + POLL_FOR_MS),
    POLL_EVERY_MS,
  );
});

test("one more read is timed for just after the next deadline, by the chain's clock", () => {
  // The chain said it was 1000 and the deadline is 1060: a minute, less what has passed since, and a moment to be sure.
  assert.equal(deadlineDelayMs(1060, 1000, 0), 61_500);
  assert.equal(deadlineDelayMs(1060, 1000, 20_000), 41_500);
  // Already late by the time it is worked out: soon, not immediately.
  assert.equal(deadlineDelayMs(1060, 1000, 90_000), 1_500);
  // No deadline ahead, or one already passed on the chain's clock: nothing to wait for.
  assert.equal(deadlineDelayMs(null, 1000, 0), null);
  assert.equal(deadlineDelayMs(1000, 1000, 0), null);
  assert.equal(deadlineDelayMs(900, 1000, 0), null);
  // A deadline years away is held to what a timer can hold.
  assert.equal(deadlineDelayMs(1000 + 10 ** 9, 1000, 0), 2_147_000_000);
});
