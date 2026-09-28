// Unit tests for kind:44002 provenance extraction (model, cost_tokens,
// sources) — untrusted tags re-checked against the ingest bounds
// (docs/agent-wiki.md).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/wiki/lib/provenance.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PROVENANCE_MAX_SOURCES, extractProvenance } from "./provenance.ts";

const EVENT_ID_A = "a".repeat(64);
const EVENT_ID_B = "b".repeat(64);

describe("extractProvenance", () => {
  it("extracts the full provenance tag set", () => {
    const provenance = extractProvenance([
      ["d", "default/standup"],
      ["model", "glm-5.3-flash"],
      ["cost_tokens", "4321"],
      ["sources", `${EVENT_ID_A},${EVENT_ID_B}`],
    ]);
    assert.equal(provenance.model, "glm-5.3-flash");
    assert.equal(provenance.costTokens, 4321);
    assert.deepEqual(provenance.sources, [EVENT_ID_A, EVENT_ID_B]);
  });

  it("returns empty provenance when no tags are present", () => {
    assert.deepEqual(extractProvenance([["d", "default/standup"]]), {
      model: null,
      costTokens: null,
      sources: [],
    });
  });

  it("takes the first non-empty value of a duplicated tag", () => {
    const provenance = extractProvenance([
      ["model", ""],
      ["model", "first-model"],
      ["model", "second-model"],
    ]);
    assert.equal(provenance.model, "first-model");
  });

  it("rejects a non-decimal or over-long cost", () => {
    for (const bad of ["12x", "abc", "-5", "1 2", "1".repeat(17)]) {
      assert.equal(extractProvenance([["cost_tokens", bad]]).costTokens, null);
    }
    assert.equal(extractProvenance([["cost_tokens", "0"]]).costTokens, 0);
  });

  it("splits, validates, dedupes, and bounds source ids", () => {
    const provenance = extractProvenance([
      [
        "sources",
        [
          EVENT_ID_A,
          EVENT_ID_B.toUpperCase(), // normalised back to lowercase
          EVENT_ID_A, // duplicate
          "not-an-id",
          "c".repeat(63), // too short
          ` ${EVENT_ID_B} `, // surrounding whitespace
        ].join(","),
      ],
    ]);
    assert.deepEqual(provenance.sources, [EVENT_ID_A, EVENT_ID_B]);
  });

  it("caps the source list at the ingest bound", () => {
    const ids = Array.from(
      { length: PROVENANCE_MAX_SOURCES + 10 },
      (_, index) => index.toString(16).padStart(64, "0"),
    );
    const provenance = extractProvenance([["sources", ids.join(",")]]);
    assert.equal(provenance.sources.length, PROVENANCE_MAX_SOURCES);
    assert.deepEqual(provenance.sources, ids.slice(0, PROVENANCE_MAX_SOURCES));
  });

  it("bounds an over-long model tag", () => {
    const provenance = extractProvenance([["model", "m".repeat(300)]]);
    assert.equal(provenance.model?.length, 128);
  });
});
