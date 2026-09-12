import assert from "node:assert/strict";
import test from "node:test";

import { relativeTime } from "./relative-time.ts";

/**
 * `relativeTime` takes a Unix timestamp in **seconds**, which is what every
 * relay event carries. Passing milliseconds is the easy mistake: the value then
 * looks like a timestamp far in the future and the function reports "just now"
 * for everything.
 */

const secondsAgo = (seconds) => Math.floor(Date.now() / 1000) - seconds;

test("seconds, minutes, hours, days and months", () => {
  assert.equal(relativeTime(secondsAgo(5)), "just now");
  assert.equal(relativeTime(secondsAgo(60)), "1 minute ago");
  assert.equal(relativeTime(secondsAgo(60 * 45)), "45 minutes ago");
  assert.equal(relativeTime(secondsAgo(60 * 60)), "1 hour ago");
  assert.equal(relativeTime(secondsAgo(60 * 60 * 5)), "5 hours ago");
  assert.equal(relativeTime(secondsAgo(60 * 60 * 24)), "1 day ago");
  assert.equal(relativeTime(secondsAgo(60 * 60 * 24 * 9)), "9 days ago");
  assert.equal(relativeTime(secondsAgo(60 * 60 * 24 * 31)), "1 month ago");
  assert.equal(relativeTime(secondsAgo(60 * 60 * 24 * 90)), "3 months ago");
});

test("a millisecond value renders as just now, which is the trap", () => {
  // A millisecond value lands far in the future, every branch reads false, and
  // the caller gets "just now" for a message that is hours old. The function
  // cannot detect this, so the call site is the only defence — which is why a
  // search result carried the bug unnoticed. `tests/e2e/a11y.spec.ts` asserts the
  // rendered result instead.
  assert.equal(relativeTime(secondsAgo(60 * 60) * 1000), "just now");
});

test("a clock ahead of us still renders something sensible", () => {
  // Client clocks disagree; a message stamped in the future must not crash.
  assert.equal(relativeTime(secondsAgo(-90)), "just now");
});
