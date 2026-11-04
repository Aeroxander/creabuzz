import assert from "node:assert/strict";
import test from "node:test";

import { workClaimStatus } from "./work-status.ts";

const record = (status, amount = 0n) => ({ status, amount });

test("an unbound submission reads Submitted; an accepted one reads In review", () => {
  assert.equal(workClaimStatus(record("Open", 0n), false), "Submitted");
  assert.equal(workClaimStatus(record("Open", 0n), true), "In review");
});

test("the end of review is its own label, never an award", () => {
  assert.equal(
    workClaimStatus(record("Approved", 0n), true),
    "Review complete",
  );
});

test("money and no-money finals keep the shared words", () => {
  assert.equal(workClaimStatus(record("Paid", 5n), true), "Paid");
  // A claim that asked for no money moved none: finished, never paid.
  assert.equal(workClaimStatus(record("Paid", 0n), true), "Finished");
});
