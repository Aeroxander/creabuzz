import assert from "node:assert/strict";
import { test } from "node:test";

import { bySize, openCountLine, SIZE_FILTERS } from "./open-work.ts";

const req = (id, size) => ({ id, ask: { size } });
const all = [req("a", "small"), req("b", "large"), req("c", "small")];

test("a size chip keeps only that size, in the order given; Any size keeps all", () => {
  assert.deepEqual(
    bySize(all, "small").map((r) => r.id),
    ["a", "c"],
  );
  assert.deepEqual(bySize(all, "medium"), []);
  assert.deepEqual(
    bySize(all, "all").map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    SIZE_FILTERS.map((f) => f.id),
    ["all", "small", "medium", "large"],
  );
});

test("the count reads as words", () => {
  assert.equal(openCountLine(0), "No open requests");
  assert.equal(openCountLine(1), "1 open request");
  assert.equal(openCountLine(4), "4 open requests");
});
