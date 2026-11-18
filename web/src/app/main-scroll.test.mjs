import assert from "node:assert/strict";
import test from "node:test";

const { isTraversal, mainScrollTarget } = await import("./main-scroll.ts");

test("only Back, Forward and history.go count as returning to a page", () => {
  assert.equal(isTraversal("BACK"), true);
  assert.equal(isTraversal("FORWARD"), true);
  assert.equal(isTraversal("GO"), true);
  assert.equal(isTraversal("PUSH"), false);
  assert.equal(isTraversal("REPLACE"), false);
});

test("a page returned to goes back to its saved position; anything else starts at the top", () => {
  assert.equal(mainScrollTarget(true, 640), 640);
  assert.equal(mainScrollTarget(true, undefined), 0);
  assert.equal(mainScrollTarget(false, 640), 0);
});
