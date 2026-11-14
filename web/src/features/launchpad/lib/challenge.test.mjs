import assert from "node:assert/strict";
import test from "node:test";

import { challengeFor, challengePickKey } from "./challenge.ts";

test("a claim still being judged, or approved and waiting, can be frozen; a frozen one can be unwound", () => {
  assert.equal(challengeFor("Open"), "freeze");
  assert.equal(challengeFor("Approved"), "freeze");
  assert.equal(challengeFor("Frozen"), "unwind");
});

test("a claim already paid, recovered or closed offers nothing to challenge", () => {
  for (const status of ["Paid", "Recovered", "Rejected", "Closed", ""]) {
    assert.equal(challengeFor(status), null, status);
  }
});

test("the pick key matches how the forms key a claim, whatever the address case", () => {
  assert.equal(
    challengePickKey({ kind: "freeze", mandate: "0xAbC", claimId: "0x01" }),
    "0xabc:0x01",
  );
});
