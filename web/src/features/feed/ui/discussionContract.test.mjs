import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The launch discussion's two extras have to stay visibly theirs:
 *
 * - founder updates render pinned, newest first, labelled as the founder's —
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
  assert.match(source, /Pinned · founder update/);
  // Ordering comes from the tested pure helper, newest first.
  assert.match(source, /pinnedUpdates\(/);
});

test("the agent summary is a distinct, clearly-badged card", () => {
  const source = read(DISCUSSION);
  assert.match(source, /data-testid="thread-summary-card"/);
  assert.match(source, /Summarized by agent/);
  assert.match(source, /newestSummary\(/);
  // One owner for the opt-in label: a single switch, no duplicate text.
  const switches = source.match(/role="switch"/g) ?? [];
  assert.equal(switches.length, 1);
  assert.equal((source.match(/Agent thread summaries/g) ?? []).length, 1);
});
