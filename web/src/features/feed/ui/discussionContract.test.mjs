import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The launch discussion's two extras have to stay visibly theirs:
 *
 * - the team's updates render pinned, newest first, labelled as the team's —
 *   never mixed into the reply stream where a reader could mistake one for a
 *   reply;
 * - the agent's thread summary renders as its own card, badged "Summarized by
 *   agent …", so no reader takes agent words for a person's post.
 *
 * These read production source (the `editSurfaceContract.test.mjs` pattern).
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

const DISCUSSION = "src/features/feed/ui/LaunchDiscussion.tsx";

test("founder updates render pinned, newest first", () => {
  const source = read(DISCUSSION);
  assert.match(source, /data-testid="pinned-updates"/);
  assert.match(source, /data-testid="pinned-update"/);
  assert.match(source, /Pinned · team update/);
  // Ordering comes from the tested pure helper, newest first.
  assert.match(source, /pinnedUpdates\(/);
});

test("the agent summary is a distinct, clearly-badged card", () => {
  const source = read(DISCUSSION);
  assert.match(source, /data-testid="thread-summary-card"/);
  assert.match(source, /Summarized by agent/);
  assert.match(source, /newestSummary\(/);
});

test("the page offers no summary switch or button: nothing here writes a summary", () => {
  const source = read(DISCUSSION);
  assert.doesNotMatch(source, /role="switch"/);
  assert.doesNotMatch(source, /Agent thread summaries/);
  assert.doesNotMatch(source, /Summarize thread/);
  assert.doesNotMatch(
    read("src/features/feed/lib/launch-thread.ts"),
    /generateThreadSummary/,
  );
});
