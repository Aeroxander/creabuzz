import assert from "node:assert/strict";
import test from "node:test";

import { npubEncode } from "nostr-tools/nip19";

import { resolveProfileParam } from "./profile-param.ts";

const KEY = "ab".repeat(32);

test("a hex key is that person, already in its own address", () => {
  assert.deepEqual(resolveProfileParam(KEY, null), {
    kind: "person",
    pubkey: KEY,
    canonical: true,
  });
});

test("an upper-case key or an npub is the same person, rewritten to the hex address", () => {
  assert.deepEqual(resolveProfileParam(KEY.toUpperCase(), null), {
    kind: "person",
    pubkey: KEY,
    canonical: false,
  });
  assert.deepEqual(resolveProfileParam(npubEncode(KEY), null), {
    kind: "person",
    pubkey: KEY,
    canonical: false,
  });
});

test("me is the signed-in account, and nobody when signed out", () => {
  assert.deepEqual(resolveProfileParam("me", KEY), {
    kind: "person",
    pubkey: KEY,
    canonical: false,
  });
  assert.deepEqual(resolveProfileParam("Me", null), { kind: "signed-out" });
});

test("anything else names nobody", () => {
  for (const param of ["mo", "not-a-key", "ab".repeat(31), `${KEY}00`, ""]) {
    assert.deepEqual(
      resolveProfileParam(param, KEY),
      { kind: "not-found" },
      param,
    );
  }
  // A post reference is not a person.
  assert.deepEqual(
    resolveProfileParam(
      "note1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sm6q9v2",
      KEY,
    ).kind,
    "not-found",
  );
});
