import assert from "node:assert/strict";
import test from "node:test";

import {
  generateThreadSummary,
  newestSummary,
  parseThreadSummary,
  pinnedUpdates,
  readSummaryOptIn,
  writeSummaryOptIn,
} from "./launch-thread.ts";

const KIND_THREAD_SUMMARY = 39005;

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

function summaryEvent(overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    kind: KIND_THREAD_SUMMARY,
    created_at: 500,
    tags: [["a", "37001:aa:s1"]],
    content: "The thread settled on two open questions.",
    ...overrides,
  };
}

test("a thread summary parses with its launch coordinate", () => {
  const parsed = parseThreadSummary(summaryEvent());
  assert.ok(parsed);
  assert.equal(parsed.launchCoord, "37001:aa:s1");
  assert.equal(parsed.text, "The thread settled on two open questions.");
  // Not a summary kind, or an empty one — never rendered as agent words.
  assert.equal(parseThreadSummary(summaryEvent({ kind: 1 })), null);
  assert.equal(parseThreadSummary(summaryEvent({ content: "  " })), null);
});

test("the freshest summary wins", () => {
  const old = parseThreadSummary(
    summaryEvent({ id: "1".repeat(64), created_at: 1 }),
  );
  const fresh = parseThreadSummary(
    summaryEvent({ id: "2".repeat(64), created_at: 9 }),
  );
  assert.equal(newestSummary([old, fresh]).id, "2".repeat(64));
  assert.equal(newestSummary([]), null);
});

test("the founder's opt-in round-trips per launch", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.equal(readSummaryOptIn("coord-1"), false);
    writeSummaryOptIn("coord-1", true);
    assert.equal(readSummaryOptIn("coord-1"), true);
    assert.equal(readSummaryOptIn("coord-2"), false);
    writeSummaryOptIn("coord-1", false);
    assert.equal(readSummaryOptIn("coord-1"), false);
  } finally {
    delete globalThis.localStorage;
  }
});

test("generation is the one stub and says so plainly", async () => {
  await assert.rejects(
    () => generateThreadSummary({ launchCoord: "c", thread: [] }),
    /not available yet/,
  );
});
