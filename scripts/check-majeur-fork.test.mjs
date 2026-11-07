import assert from "node:assert/strict";
import test from "node:test";

import { checkFork, patchRegions, stripPatchRegions } from "./check-majeur-fork.mjs";

/**
 * The guard is only worth having if it can actually see a stray edit. These
 * pin the two ways it must fail: a change outside the marked regions, and a
 * malformed region (Review-Proven Rule 3 — a check nobody can break protects
 * nothing).
 */

test("marked regions are removed, markers and all", () => {
  const source = [
    "line one",
    "// @@CREABUZZ PATCH BEGIN a",
    "inserted",
    "// @@CREABUZZ PATCH END a",
    "line two",
  ].join("\n");
  assert.equal(stripPatchRegions(source), "line one\nline two");
});

test("an edit outside a region survives, so the comparison can see it", () => {
  const source = [
    "line one",
    "SNEAKY EDIT",
    "// @@CREABUZZ PATCH BEGIN a",
    "inserted",
    "// @@CREABUZZ PATCH END a",
  ].join("\n");
  assert.equal(stripPatchRegions(source), "line one\nSNEAKY EDIT");
});

test("an unclosed region is refused rather than silently swallowed", () => {
  assert.throws(
    () => stripPatchRegions("// @@CREABUZZ PATCH BEGIN a\ninserted\n"),
    /never closed/,
  );
});

test("a region closed by the wrong name is refused", () => {
  assert.throws(
    () =>
      stripPatchRegions(
        "// @@CREABUZZ PATCH BEGIN a\ninserted\n// @@CREABUZZ PATCH END b\n",
      ),
    /closed by "b"/,
  );
});

test("a nested region is refused", () => {
  assert.throws(
    () =>
      stripPatchRegions(
        "// @@CREABUZZ PATCH BEGIN a\n// @@CREABUZZ PATCH BEGIN b\n// @@CREABUZZ PATCH END b\n// @@CREABUZZ PATCH END a\n",
      ),
    /nested patch region/,
  );
});

test("regions are reported with how much each one carries", () => {
  const regions = patchRegions(
    [
      "upstream",
      "// @@CREABUZZ PATCH BEGIN a",
      "one",
      "two",
      "// @@CREABUZZ PATCH END a",
    ].join("\n"),
  );
  assert.deepEqual(regions, [{ name: "a", lines: 2 }]);
});

// ---- the verdict ----

const UPSTREAM = ["line one", "line two"].join("\n");

test("a fork whose edits are all marked is accepted", () => {
  const fork = [
    "line one",
    "// @@CREABUZZ PATCH BEGIN a",
    "ours",
    "// @@CREABUZZ PATCH END a",
    "line two",
  ].join("\n");
  const result = checkFork(fork, UPSTREAM);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /1 patch region/);
});

test("a stray edit outside a region is rejected and named", () => {
  const fork = [
    "line one",
    "line two but different",
    "// @@CREABUZZ PATCH BEGIN a",
    "ours",
    "// @@CREABUZZ PATCH END a",
  ].join("\n");
  const result = checkFork(fork, UPSTREAM);
  assert.equal(result.ok, false);
  assert.match(result.message, /OUTSIDE a patch region/);
  assert.match(result.message, /line two but different/);
});

test("an empty patch region is rejected", () => {
  const fork = [
    "line one",
    "// @@CREABUZZ PATCH BEGIN a",
    "// @@CREABUZZ PATCH END a",
    "line two",
  ].join("\n");
  const result = checkFork(fork, UPSTREAM);
  assert.equal(result.ok, false);
  assert.match(result.message, /empty patch region/);
});
