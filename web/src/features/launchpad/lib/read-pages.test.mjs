import assert from "node:assert/strict";
import test from "node:test";

import { readPages } from "./read-pages.ts";

/** A relay holding `count` records, one per second, that answers like one: newest first, `until` inclusive. */
const relayOf = (count, sameSecond = false) => {
  const all = Array.from({ length: count }, (_, i) => ({
    id: `id${String(i).padStart(5, "0")}`,
    created_at: sameSecond ? 1000 : 1000 + i,
  })).reverse();
  const asked = [];
  const query = async ({ until, limit }) => {
    asked.push({ until, limit });
    return all
      .filter((e) => until === undefined || e.created_at <= until)
      .slice(0, limit);
  };
  return { query, asked };
};

test("a list shorter than a page is read in one ask and is not cut", async () => {
  const { query, asked } = relayOf(30);
  const read = await readPages(query, { limit: 100, maxPages: 5 });
  assert.equal(read.events.length, 30);
  assert.equal(read.cut, false);
  assert.equal(asked.length, 1);
});

test("a record buried under a full page of newer ones is found on the next page", async () => {
  // 250 records, 100 to a page: the oldest (id00000) is on the third page.
  const { query, asked } = relayOf(250);
  const read = await readPages(query, { limit: 100, maxPages: 5 });
  assert.equal(read.events.length, 250);
  assert.ok(read.events.some((e) => e.id === "id00000"));
  assert.equal(read.cut, false);
  assert.equal(asked.length, 3);
});

test("a list deeper than the bound is read to the bound and says it was cut", async () => {
  const { query, asked } = relayOf(1000);
  const read = await readPages(query, { limit: 100, maxPages: 3 });
  // `until` is inclusive, so each later page starts on the last record of the one before: 100 + 99 + 99.
  assert.equal(read.events.length, 298);
  assert.equal(read.cut, true);
  assert.equal(asked.length, 3);
});

test("a full page of records signed in the same second ends the read, cut, and does not ask forever", async () => {
  const { query, asked } = relayOf(500, true);
  const read = await readPages(query, { limit: 100, maxPages: 10 });
  assert.equal(read.cut, true);
  assert.ok(asked.length <= 2, `asked ${asked.length} times`);
});

test("a page's failure is the read's failure, not a shorter list", async () => {
  let calls = 0;
  await assert.rejects(
    readPages(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error("server said no");
        return Array.from({ length: 10 }, (_, i) => ({
          id: `x${i}`,
          created_at: 100 - i,
        }));
      },
      { limit: 10, maxPages: 5 },
    ),
    /server said no/,
  );
});
