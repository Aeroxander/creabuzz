import assert from "node:assert/strict";
import test from "node:test";

import { tabKeyTarget } from "./tab-strip-keys.ts";

test("arrow keys step through the tabs and wrap at the ends", () => {
  assert.equal(tabKeyTarget("ArrowRight", 0, 3), 1);
  assert.equal(tabKeyTarget("ArrowRight", 2, 3), 0);
  assert.equal(tabKeyTarget("ArrowLeft", 0, 3), 2);
  assert.equal(tabKeyTarget("ArrowLeft", 2, 3), 1);
});

test("Home and End jump to the first and last tab", () => {
  assert.equal(tabKeyTarget("Home", 2, 3), 0);
  assert.equal(tabKeyTarget("End", 0, 3), 2);
});

test("other keys are left to the browser", () => {
  for (const key of ["Tab", "Enter", " ", "ArrowDown", "a"]) {
    assert.equal(tabKeyTarget(key, 1, 3), null);
  }
  assert.equal(tabKeyTarget("ArrowRight", 0, 0), null);
});
