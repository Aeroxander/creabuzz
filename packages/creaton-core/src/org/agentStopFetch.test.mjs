import assert from "node:assert/strict";
import test from "node:test";

import { fetchOwnRecords } from "./agentStopFetch.ts";

/** A synthetic live-revision page stream over `records` in age order. */
function pagedQuery(records, pageSizeSeenByClient) {
  const calls = [];
  const newestFirst = [...records].sort((a, b) => b.created_at - a.created_at);
  return {
    calls,
    query: async (filter) => {
      calls.push(filter);
      const until = filter.until ?? Number.POSITIVE_INFINITY;
      return newestFirst
        .filter((r) => r.created_at <= until)
        .slice(0, pageSizeSeenByClient);
    },
  };
}

function record(id, d, age) {
  return {
    id,
    tags: [["d", d]],
    created_at: age,
    content: "{}",
  };
}

test("pages to exhaustion: records beyond the first window are found", async () => {
  const records = [
    record("a", "seat-1", 100),
    record("b", "seat-2", 200),
    record("c", "seat-3", 300),
    record("d", "seat-4", 400),
    record("e", "seat-5", 500),
  ];
  const { query } = pagedQuery(records, 2);
  const found = await fetchOwnRecords(query, "me", 37010, undefined, {
    pageSize: 2,
    maxPages: 10,
  });
  assert.equal(found.length, 5);
  assert.deepEqual(
    found.map((r) => r.d).sort(),
    ["seat-1", "seat-2", "seat-3", "seat-4", "seat-5"],
  );
});

test("the d-tag filter still scopes after paging", async () => {
  const records = [
    record("a", "seat-1", 100),
    record("b", "grant-x", 200),
    record("c", "seat-1", 300),
    record("d", "grant-x", 400),
    record("e", "seat-1", 500),
  ];
  const { query } = pagedQuery(records, 2);
  const found = await fetchOwnRecords(query, "me", 37012, "seat-1", {
    pageSize: 2,
    maxPages: 10,
  });
  assert.equal(found.length, 3);
  assert.ok(found.every((r) => r.d === "seat-1"));
});

test("hitting the page valve throws instead of returning a partial set", async () => {
  const records = Array.from({ length: 10 }, (_, i) =>
    record(`id-${i}`, "seat", 1000 - i),
  );
  const { query } = pagedQuery(records, 2);
  await assert.rejects(
    fetchOwnRecords(query, "me", 37010, undefined, {
      pageSize: 2,
      maxPages: 2,
    }),
    /run the stop again/,
  );
});

test("a full page of duplicates terminates without spinning", async () => {
  const same = record("a", "seat", 100);
  let calls = 0;
  const query = async () => {
    calls += 1;
    return [same, record("b", "seat", 100), record("c", "seat", 100)];
  };
  const found = await fetchOwnRecords(query, "me", 37010, undefined, {
    pageSize: 3,
    maxPages: 10,
  });
  assert.equal(found.length, 3);
  assert.equal(calls, 2, "the duplicate-only second page must end the loop");
});
