import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSlug } from "./slug.ts";

/**
 * The page dialog and the `[[wikilink]]` extractor must agree on this rule, or a
 * link written by hand never resolves: both had their own copy.
 */
test("page names normalise to a slug", () => {
  assert.equal(normalizeSlug("Release Notes"), "release-notes");
  assert.equal(normalizeSlug("  Release Notes!  "), "release-notes");
  assert.equal(normalizeSlug("Treasury  Policy"), "treasury-policy");
  assert.equal(normalizeSlug("Q3/2026 Plan"), "q3-2026-plan");
  // Underscores are part of the alphabet this rule allows (they are valid in a
  // slug), so only the hyphen runs introduced by the substitution are trimmed.
  assert.equal(
    normalizeSlug("__leading and trailing__"),
    "__leading-and-trailing__",
  );
  assert.equal(normalizeSlug("-spaced-out-"), "spaced-out");
});

test("a name with nothing usable in it yields no slug", () => {
  assert.equal(normalizeSlug("   "), "");
  assert.equal(normalizeSlug("!!!"), "");
});

test("long names are capped, and the cap lands on a boundary", () => {
  const slug = normalizeSlug("a".repeat(200));
  assert.equal(slug.length, 64);
  assert.ok(!slug.endsWith("-"));
});
