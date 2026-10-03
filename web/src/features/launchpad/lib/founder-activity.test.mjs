import assert from "node:assert/strict";
import test from "node:test";

import { activityRows, parseSeenCounts } from "./founder-activity.ts";

const mine = [
  { coord: "c1", id: "one", author: "f", name: "One" },
  { coord: "c2", id: "two", author: "f", name: "Two" },
  { coord: "c3", id: "three", author: "f", name: "Three" },
];

test("new supporters are the count above what the founder last saw", () => {
  const rows = activityRows(
    mine,
    new Map([
      ["c1", 5],
      ["c2", 2],
      ["c3", 0],
    ]),
    { c1: 3, c2: 2 },
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.fresh, r.total]),
    [["one", 2, 5]],
  );
});

test("a launch never seen before counts everyone as new, most new first", () => {
  const rows = activityRows(
    mine,
    new Map([
      ["c1", 1],
      ["c2", 4],
    ]),
    {},
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["two", "one"],
  );
});

test("losing supporters is not negative news", () => {
  const rows = activityRows(mine, new Map([["c1", 1]]), { c1: 9 });
  assert.deepEqual(rows, []);
});

test("unreadable stored counts are ignored, not trusted", () => {
  assert.deepEqual(parseSeenCounts(null), {});
  assert.deepEqual(parseSeenCounts("not json"), {});
  assert.deepEqual(parseSeenCounts("[1,2]"), {});
  assert.deepEqual(parseSeenCounts('{"a":3,"b":"x","c":-1,"d":1.5}'), { a: 3 });
});
