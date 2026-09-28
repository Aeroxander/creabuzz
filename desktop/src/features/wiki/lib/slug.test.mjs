// Unit tests for the wiki slug rules: kind:44001 slug normalisation (shared
// with `[[wikilink]]` extraction) and the kind:44002 `<space>/<slug>` grammar.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/wiki/lib/slug.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeSlug, parseSpaceSlug } from "./slug.ts";

describe("normalizeSlug", () => {
  it("page names normalise to a slug", () => {
    assert.equal(normalizeSlug("Release Notes"), "release-notes");
    assert.equal(normalizeSlug("  Release Notes!  "), "release-notes");
    assert.equal(normalizeSlug("Treasury  Policy"), "treasury-policy");
    assert.equal(normalizeSlug("Q3/2026 Plan"), "q3-2026-plan");
    // Underscores are part of the alphabet this rule allows, so only the
    // hyphen runs introduced by the substitution are trimmed.
    assert.equal(
      normalizeSlug("__leading and trailing__"),
      "__leading-and-trailing__",
    );
    assert.equal(normalizeSlug("-spaced-out-"), "spaced-out");
  });

  it("a name with nothing usable in it yields no slug", () => {
    assert.equal(normalizeSlug("   "), "");
    assert.equal(normalizeSlug("!!!"), "");
  });

  it("long names are capped, and the cap lands on a boundary", () => {
    const slug = normalizeSlug("a".repeat(200));
    assert.equal(slug.length, 64);
    assert.ok(!slug.endsWith("-"));
  });
});

describe("parseSpaceSlug", () => {
  it("splits space from the slug", () => {
    assert.deepEqual(parseSpaceSlug("default/standup"), {
      space: "default",
      slug: "standup",
    });
  });

  it("keeps nested slugs after the space segment", () => {
    assert.deepEqual(parseSpaceSlug("default/projects/research/standup"), {
      space: "default",
      slug: "projects/research/standup",
    });
  });

  it("accepts segment characters of the documented grammar", () => {
    assert.deepEqual(parseSpaceSlug("research-2/2026.q1_summary"), {
      space: "research-2",
      slug: "2026.q1_summary",
    });
  });

  it("rejects d tags without a <space>/<slug> shape", () => {
    assert.equal(parseSpaceSlug(""), null);
    assert.equal(parseSpaceSlug("standup"), null);
    assert.equal(parseSpaceSlug("default/"), null);
    assert.equal(parseSpaceSlug("/standup"), null);
    assert.equal(parseSpaceSlug("default//standup"), null);
  });

  it("rejects segments outside the grammar", () => {
    assert.equal(parseSpaceSlug("Default/standup"), null); // uppercase space
    assert.equal(parseSpaceSlug("default/Standup"), null); // uppercase slug
    assert.equal(parseSpaceSlug("default/stand up"), null); // space
    assert.equal(parseSpaceSlug("_default/standup"), null); // leading _
    assert.equal(parseSpaceSlug("default/.hidden"), null); // leading .
    assert.equal(parseSpaceSlug("default/standup!"), null); // punctuation
    assert.equal(parseSpaceSlug("défault/standup"), null); // non-ascii
  });

  it("rejects d tags beyond the 256-byte bound", () => {
    const overlong = `default/${"a".repeat(256)}`;
    assert.equal(parseSpaceSlug(overlong), null);
    const atBound = `default/${"a".repeat(248)}`;
    assert.equal(atBound.length, 256);
    assert.deepEqual(parseSpaceSlug(atBound), {
      space: "default",
      slug: "a".repeat(248),
    });
  });
});
