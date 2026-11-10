import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOVED_READ_LIMIT,
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

test("the founder's deleted update records are counted, each once, with when the last was", () => {
  const removed = removedRecords(
    [del(FOUNDER, 10, ["a", "b"]), del(FOUNDER, 30, ["b", "c"])],
    FOUNDER,
  );
  assert.deepEqual(removed, { count: 3, lastAt: 30, atLeast: false });
  assert.equal(
    removedLine(removed, day),
    "The founder has removed 3 update records, the last on day 30.",
  );
});

test("someone else's deletions, and deletions of other kinds of record, are not the founder's update records", () => {
  const removed = removedRecords(
    [
      del(OTHER, 10, ["a"]),
      del(FOUNDER, 20, ["b"], "1"),
      del(FOUNDER, 25, ["c"], null),
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
  );
  assert.deepEqual(removed, { count: 0, lastAt: null, atLeast: false });
  assert.equal(removedLine(removed, day), null);
});

test("one removed record reads as one, and a cut read says at least", () => {
  assert.equal(
    removedLine(removedRecords([del(FOUNDER, 5, ["a"])], FOUNDER), day),
    "The founder has removed 1 update record, the last on day 5.",
  );
  const many = [];
  for (let i = 0; i < REMOVED_READ_LIMIT; i += 1)
    many.push(del(FOUNDER, i, [`id${i}`]));
  const removed = removedRecords(many, FOUNDER);
  assert.equal(removed.atLeast, true);
  assert.match(
    removedLine(removed, day),
    /^The founder has removed at least 500 update records/,
  );
});
