import assert from "node:assert/strict";
import test from "node:test";

import * as thread from "./launch-thread.ts";

const { pinnedUpdates } = thread;

function update(id, createdAt) {
  return { id, author: "f".repeat(64), createdAt, title: "T", body: "B" };
}

test("pinned founder updates render newest first", () => {
  const a = update("aaa", 100);
  const b = update("bbb", 300);
  const c = update("ccc", 200);
  assert.deepEqual(
    pinnedUpdates([a, b, c]).map((u) => u.id),
    ["bbb", "ccc", "aaa"],
  );
  // Ties break by id so the row order never flickers between renders.
  const t1 = update("aaa", 100);
  const t2 = update("bbb", 100);
  assert.equal(pinnedUpdates([t1, t2])[0].id, "bbb");
  // The input is not mutated.
  assert.deepEqual(
    [a, b, c].map((u) => u.id),
    ["aaa", "bbb", "ccc"],
  );
});

test("the page never offers to write a summary: no opt-in and no generator are left", () => {
  for (const gone of [
    "generateThreadSummary",
    "readSummaryOptIn",
    "writeSummaryOptIn",
    // Kind 39005 is the server's own record (D156): a client never reads an agent's words from it.
    "parseThreadSummary",
    "newestSummary",
  ]) {
    assert.equal(gone in thread, false, gone);
  }
});
