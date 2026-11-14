import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressesInRecord,
  personLabeler,
  pubkeysToName,
  shortAddress,
} from "./record-people.ts";

const A = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const C = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

test("an address is shortened to its start and end", () => {
  assert.equal(shortAddress(A.toLowerCase()), "0xf39f…2266");
});

test("a wallet exactly one person bound is shown by their name, beside the address", () => {
  const label = personLabeler(
    [{ pubkey: ALICE, address: A.toLowerCase() }],
    (pubkey) => (pubkey === ALICE ? "Alice" : null),
  );
  assert.equal(label(A), "Alice");
  assert.equal(label(A.toLowerCase()), "Alice");
});

test("a wallet nobody bound, or whose owner has no name, stays an address", () => {
  const label = personLabeler(
    [{ pubkey: BOB, address: B.toLowerCase() }],
    () => null,
  );
  assert.equal(label(A), "0xf39f…2266");
  assert.equal(label(B), "0x7099…79c8");
});

test("a wallet two different people claim is never given a name", () => {
  const label = personLabeler(
    [
      { pubkey: ALICE, address: A.toLowerCase() },
      { pubkey: BOB, address: A.toLowerCase() },
    ],
    () => "Someone",
  );
  assert.equal(label(A), "0xf39f…2266");
});

test("the same person listed twice for one wallet still counts as one", () => {
  const label = personLabeler(
    [
      { pubkey: ALICE, address: A.toLowerCase() },
      { pubkey: ALICE, address: A.toLowerCase() },
    ],
    () => "Alice",
  );
  assert.equal(label(A), "Alice");
});

test("the wallets a record names are collected once each, from claims, reviewers and the team", () => {
  const work = {
    mandates: [
      {
        claims: [
          { record: { contributor: A } },
          { record: { contributor: A } },
        ],
      },
    ],
  };
  const events = {
    verdicts: new Map([["k", [{ reviewer: B, approve: true }]]]),
    promises: [{ holder: C }],
  };
  assert.deepEqual(
    addressesInRecord(work, events).sort(),
    [A, B, C].map((a) => a.toLowerCase()).sort(),
  );
});

test("only people with a wallet the record names are looked up, at most the limit", () => {
  const people = [
    { pubkey: ALICE, address: A.toLowerCase() },
    { pubkey: BOB, address: B.toLowerCase() },
  ];
  assert.deepEqual(pubkeysToName(people, [A]), [ALICE]);
  assert.deepEqual(pubkeysToName(people, [A, B], 1), [ALICE]);
  assert.deepEqual(pubkeysToName(people, []), []);
});
