import assert from "node:assert/strict";
import test from "node:test";

import { indexProfiles } from "./index-profiles.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

const profile = (pubkey, name, created_at = 100) => ({
  pubkey,
  created_at,
  content: JSON.stringify({ display_name: name }),
});

test("each author keeps their own profile when one has none", () => {
  // The regression: an author without metadata shortened the array, so every
  // later author was given the previous one's name.
  const indexed = indexProfiles([profile(BOB, "Bob"), profile(CAROL, "Carol")]);
  assert.equal(indexed[BOB]?.display_name, "Bob");
  assert.equal(indexed[CAROL]?.display_name, "Carol");
  assert.equal(indexed[ALICE], undefined);
});

test("relay ordering does not matter", () => {
  const forward = indexProfiles([profile(ALICE, "Alice"), profile(BOB, "Bob")]);
  const reversed = indexProfiles([
    profile(BOB, "Bob"),
    profile(ALICE, "Alice"),
  ]);
  assert.deepEqual(forward, reversed);
});

test("the newest metadata wins per author", () => {
  const indexed = indexProfiles([
    profile(ALICE, "Old name", 100),
    profile(ALICE, "New name", 200),
  ]);
  assert.equal(indexed[ALICE]?.display_name, "New name");
});

test("malformed metadata is absent, and does not break the batch", () => {
  const indexed = indexProfiles([
    { pubkey: ALICE, created_at: 100, content: "not json" },
    profile(BOB, "Bob"),
  ]);
  assert.equal(indexed[ALICE], undefined);
  assert.equal(indexed[BOB]?.display_name, "Bob");
});
