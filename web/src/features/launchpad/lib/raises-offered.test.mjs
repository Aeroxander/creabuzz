import assert from "node:assert/strict";
import test from "node:test";

import { raisesOffered } from "./raises-offered.ts";

test("only a contributor-only build hides raises", () => {
  assert.equal(raisesOffered({ VITE_CONTRIBUTOR_ONLY: "1" }), false);
  assert.equal(raisesOffered({ VITE_CONTRIBUTOR_ONLY: " 1 " }), false);
  // Every other build offers them, whether or not it names a kit to launch one.
  assert.equal(raisesOffered({}), true);
  assert.equal(raisesOffered(undefined), true);
  assert.equal(raisesOffered({ VITE_CONTRIBUTOR_ONLY: "0" }), true);
});
