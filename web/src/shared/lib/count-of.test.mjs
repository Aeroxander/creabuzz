import assert from "node:assert/strict";
import test from "node:test";

import { countOf } from "./count-of.ts";

test("one is singular, everything else is plural, zero included", () => {
  assert.equal(countOf(1, "team"), "1 team");
  assert.equal(countOf(0, "team"), "0 teams");
  assert.equal(countOf(2, "team"), "2 teams");
});

test("an irregular plural is given", () => {
  assert.equal(countOf(1, "launch", "launches"), "1 launch");
  assert.equal(countOf(3, "launch", "launches"), "3 launches");
});
