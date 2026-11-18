import assert from "node:assert/strict";
import test from "node:test";

import {
  deletionsFilter,
  memberRemovedLine,
  removedLine,
  removedRecords,
} from "./removed-records.ts";

const FOUNDER = "f".repeat(64);
const OTHER = "e".repeat(64);
const del = (pubkey, at, ids, k = "47003") => ({
  kind: 5,
  pubkey,
  created_at: at,
  tags: [...ids.map((id) => ["e", id]), ...(k ? [["k", k]] : [])],
});
const day = (at) => `day ${at}`;

test("the founder's deletions are asked for by author and kind alone, so a tag filter cannot hide any", () => {
  const filter = deletionsFilter(FOUNDER);
  assert.deepEqual(filter, { kinds: [5], authors: [FOUNDER], limit: 500 });
  assert.equal(
    Object.keys(filter).some((key) => key.startsWith("#")),
    false,
  );
});

test("the founder's deleted update records are counted, each once, with when the last was", () => {
  const removed = removedRecords(
    [del(FOUNDER, 10, ["a", "b"]), del(FOUNDER, 30, ["b", "c"])],
    FOUNDER,
    true,
  );
  assert.deepEqual(removed, {
    count: 3,
    unnamed: 0,
    lastAt: 30,
    complete: true,
  });
  assert.equal(
    removedLine(removed, day),
    "The founder has removed 3 update records. The last removal was on day 30.",
  );
  assert.equal(
    removedLine(removedRecords([del(FOUNDER, 5, ["a"])], FOUNDER, true), day),
    "The founder has removed 1 update record. The last removal was on day 5.",
  );
});

test("someone else's deletions are not counted; one that claims another kind, or removes a removal, still is", () => {
  const removed = removedRecords(
    [
      del(OTHER, 10, ["a"]),
      // A false label: it says it removes a post. Nothing checks that, so it counts, apart.
      del(FOUNDER, 20, ["b"], "1"),
      // A removal of a removal counts too.
      del(FOUNDER, 25, ["c"], "5"),
      { kind: 5, pubkey: FOUNDER, created_at: 30, tags: [["a", "37001:x:y"]] },
      {
        kind: 1,
        pubkey: FOUNDER,
        created_at: 40,
        tags: [
          ["e", "d"],
          ["k", "47003"],
        ],
      },
    ],
    FOUNDER,
    true,
  );
  assert.deepEqual(removed, {
    count: 0,
    unnamed: 2,
    lastAt: 25,
    complete: true,
  });
  assert.match(
    removedLine(removed, day),
    /removed 2 records that were not marked as updates/,
  );
});

test("a deletion that does not say what kind it removes may have removed an update: it is counted apart and said", () => {
  const only = removedRecords(
    [del(FOUNDER, 25, ["c", "d"], null)],
    FOUNDER,
    true,
  );
  assert.deepEqual(only, { count: 0, unnamed: 2, lastAt: 25, complete: true });
  assert.equal(
    removedLine(only, day),
    "The founder has removed 2 records that were not marked as updates, the last on day 25. A removal can say any kind, so some may have been updates.",
  );
  const both = removedRecords(
    [del(FOUNDER, 25, ["c"], null), del(FOUNDER, 10, ["a"])],
    FOUNDER,
    true,
  );
  assert.equal(
    removedLine(both, day),
    "The founder has removed 1 update record, and 1 other record not marked as updates (a removal can say any kind). The last removal was on day 25.",
  );
  // Named both ways: an update record, once.
  assert.deepEqual(
    removedRecords(
      [del(FOUNDER, 1, ["a"], null), del(FOUNDER, 2, ["a"])],
      FOUNDER,
      true,
    ),
    { count: 1, unnamed: 0, lastAt: 2, complete: true },
  );
});

test("a read that did not reach the end says at least, and with nothing found says removals could not be checked", () => {
  assert.equal(
    removedLine(removedRecords([del(FOUNDER, 5, ["a"])], FOUNDER, false), day),
    "The founder has removed at least 1 update record. The last removal was on day 5.",
  );
  // Never "none": five hundred unrelated deletions may be hiding one.
  assert.equal(
    removedLine(removedRecords([del(OTHER, 5, ["a"])], FOUNDER, false), day),
    "Whether the founder has removed update records could not be checked: they have more removals than could be read here.",
  );
  assert.equal(removedLine(removedRecords([], FOUNDER, true), day), null);
});

test("a team member's removals are said by name, and a cut read is never 'none'", () => {
  const some = removedRecords(
    [del(OTHER, 50, ["a"]), del(OTHER, 90, ["b"], "")],
    OTHER,
    true,
  );
  assert.equal(
    memberRemovedLine("Max", some, day),
    "Max has removed 2 records, the last on day 90.",
  );
  assert.equal(
    memberRemovedLine("Max", removedRecords([], OTHER, true), day),
    null,
  );
  assert.match(
    memberRemovedLine("Max", removedRecords([], OTHER, false), day),
    /could not be checked/,
  );
  assert.match(
    memberRemovedLine("Max", { ...some, complete: false }, day),
    /at least 2 records/,
  );
});
