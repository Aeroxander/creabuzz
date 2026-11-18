// Unit tests for the org entity picker helpers (search filter + slugify).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/pickerOptions.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { filterPickerOptions, slugify } from "./pickerOptions.ts";

describe("filterPickerOptions", () => {
  const options = [
    { id: "1", label: "Engineering", sub: "team" },
    { id: "2", label: "Founder", sub: "role" },
    { id: "3", label: "Support Bot", sub: "abcd1234" },
    { id: "4", label: "engineering-lead", sub: "agent_seat" },
  ];

  it("returns all options for an empty or whitespace query", () => {
    assert.deepEqual(filterPickerOptions(options, ""), options);
    assert.deepEqual(filterPickerOptions(options, "   "), options);
  });

  it("matches labels case-insensitively", () => {
    assert.deepEqual(filterPickerOptions(options, "ENG"), [
      options[0],
      options[3],
    ]);
  });

  it("matches the sub field too", () => {
    assert.deepEqual(filterPickerOptions(options, "abcd"), [options[2]]);
    assert.deepEqual(filterPickerOptions(options, "AGENT_SEAT"), [options[3]]);
  });

  it("trims the query before matching", () => {
    assert.deepEqual(filterPickerOptions(options, "  founder "), [options[1]]);
  });

  it("returns an empty array when nothing matches", () => {
    assert.deepEqual(filterPickerOptions(options, "zzz"), []);
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    assert.equal(slugify("Leadership Circle!"), "leadership-circle");
    assert.equal(slugify("R&D / Ops"), "r-d-ops");
  });

  it("collapses runs of separators and trims edges", () => {
    assert.equal(slugify("  A   B  "), "a-b");
    assert.equal(slugify("--weird--name--"), "weird-name");
  });

  it("keeps digits and existing dashes", () => {
    assert.equal(slugify("squad-42"), "squad-42");
  });

  it("returns an empty string when nothing usable remains", () => {
    assert.equal(slugify("///"), "");
    assert.equal(slugify(""), "");
  });
});
