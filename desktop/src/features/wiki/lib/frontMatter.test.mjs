// Unit tests for the kind:44002 standup front-matter parser: the deterministic
// CLI block (`slug`, `agwiki-cursor`, `model`, `generated-at`) split from the
// body, defensively (docs/agent-wiki.md).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/wiki/lib/frontMatter.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseFrontMatter } from "./frontMatter.ts";

describe("parseFrontMatter", () => {
  it("parses the deterministic CLI block and returns the body", () => {
    const content = [
      "---",
      "slug: default/standup",
      "agwiki-cursor: 1750000000",
      "model: glm-5.3-flash",
      "generated-at: 1750000000",
      "---",
      "",
      "# Standup",
      "",
      "All quiet.",
    ].join("\n");
    const parsed = parseFrontMatter(content);
    assert.equal(parsed.slug, "default/standup");
    assert.equal(parsed.cursor, 1750000000);
    assert.equal(parsed.model, "glm-5.3-flash");
    assert.equal(parsed.generatedAt, 1750000000);
    assert.equal(parsed.body, "# Standup\n\nAll quiet.");
  });

  it("strips YAML-style inline comments from values", () => {
    const content = [
      "---",
      "agwiki-cursor: 1750000000   # durable distill cursor (see below)",
      "model: glm-5.3-flash",
      "---",
      "body",
    ].join("\n");
    const parsed = parseFrontMatter(content);
    assert.equal(parsed.cursor, 1750000000);
    assert.equal(parsed.fields["agwiki-cursor"], "1750000000");
  });

  it("returns content unchanged when there is no front-matter block", () => {
    for (const content of ["# Just prose", "", "---\nunterminated block"]) {
      const parsed = parseFrontMatter(content);
      assert.equal(parsed.body, content);
      assert.deepEqual(parsed.fields, {});
      assert.equal(parsed.slug, null);
      assert.equal(parsed.cursor, null);
    }
  });

  it("keeps the raw field but nulls a non-integer cursor", () => {
    const content = "---\nagwiki-cursor: tomorrow\n---\nbody";
    const parsed = parseFrontMatter(content);
    assert.equal(parsed.cursor, null);
    assert.equal(parsed.fields["agwiki-cursor"], "tomorrow");
    assert.equal(parsed.body, "body");
  });

  it("first occurrence wins on duplicate keys and junk lines are skipped", () => {
    const content = [
      "---",
      "not a field line",
      ": orphan",
      "model: first",
      "model: second",
      "---",
      "body",
    ].join("\n");
    const parsed = parseFrontMatter(content);
    assert.equal(parsed.model, "first");
    assert.equal(Object.keys(parsed.fields).length, 1);
  });

  it("a value containing a colon survives the first-colon split", () => {
    const parsed = parseFrontMatter("---\nslug: a:b:c\n---\nbody");
    assert.equal(parsed.slug, "a:b:c");
  });
});
