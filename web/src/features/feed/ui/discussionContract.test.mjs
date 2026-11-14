import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The project Discussion tab (D156) is one board, with the team's updates pinned above it:
 *
 * - the team's updates render pinned, newest first, labelled as the team's, never mixed into the board where a
 *   reader could mistake one for a post;
 * - talk happens on the project's own board (the board view every board uses), not a second note system;
 * - notes from before the board stay readable, with no box to write in.
 *
 * These read production source (the `editSurfaceContract.test.mjs` pattern).
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

const DISCUSSION = "src/features/feed/ui/LaunchDiscussion.tsx";
const THREADS = "src/features/feed/ui/ThreadList.tsx";

test("founder updates render pinned, newest first", () => {
  const source = read(DISCUSSION);
  assert.match(source, /data-testid="pinned-updates"/);
  assert.match(source, /data-testid="pinned-update"/);
  assert.match(source, /Pinned · team update/);
  // Ordering comes from the tested pure helper, newest first.
  assert.match(source, /pinnedUpdates\(/);
});

test("people talk on the project's board, through the board view every board uses", () => {
  const source = read(DISCUSSION);
  assert.match(source, /<BoardView/);
  assert.match(source, /record\.chat\.board/);
  assert.match(source, /data-testid="discussion-open-board"/);
});

test("notes from before the board are read-only: nothing on the tab writes a note", () => {
  for (const file of [DISCUSSION, THREADS]) {
    const source = read(file);
    assert.doesNotMatch(source, /<Composer\b/, file);
    assert.doesNotMatch(source, /from "\.\/Composer"/, file);
  }
});

test("the page shows no agent summary: kind 39005 is the server's own record", () => {
  const source = read(DISCUSSION);
  assert.doesNotMatch(source, /thread-summary-card/);
  assert.doesNotMatch(source, /Summarized by agent/);
  assert.doesNotMatch(source, /role="switch"/);
});
