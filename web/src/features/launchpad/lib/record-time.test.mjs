import assert from "node:assert/strict";
import test from "node:test";

import { supersedingTime } from "./record-time.ts";

test("a first record is stamped now", () => {
  assert.equal(supersedingTime(1000, undefined), 1000);
  assert.equal(supersedingTime(1000, null), 1000);
});

test("an older record is superseded by now", () => {
  assert.equal(supersedingTime(1000, 990), 1000);
});

test("a save in the same second still wins by a second", () => {
  assert.equal(supersedingTime(1000, 1000), 1001);
});

test("a record stamped ahead of this clock is still beaten", () => {
  assert.equal(supersedingTime(1000, 1005), 1006);
});
