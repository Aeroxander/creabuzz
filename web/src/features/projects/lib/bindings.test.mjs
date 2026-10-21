// Binding records (kind:37017): what parses, and which record per person counts.
import assert from "node:assert/strict";
import test from "node:test";

import { KIND_EVM_BINDING } from "../../../shared/constants/kinds.ts";
import { canonicalBindingByPubkey, parseBindingRecord } from "./bindings.ts";

const ALICE_PUB = "b".repeat(64);
const B_A = `0x${"11".repeat(20)}`;
const B_B = `0x${"22".repeat(20)}`;

function bindingEvent({
  pubkey = ALICE_PUB,
  address = B_B,
  d,
  content = {},
  tags = [],
  kind = KIND_EVM_BINDING,
  created_at = 100,
  id = `rec-${created_at}`,
} = {}) {
  const body = {
    v: 1,
    siweMessageHash: "0xdead",
    attestation: "sig",
    ...content,
  };
  return {
    id,
    kind,
    pubkey,
    created_at,
    tags: [["d", d ?? address.toLowerCase()], ["address", address], ...tags],
    content: JSON.stringify(body),
    sig: "sig",
  };
}

test("parseBindingRecord reads the record contract, and refuses the rest", () => {
  const parsed = parseBindingRecord(
    bindingEvent({ tags: [["chain", "11155111"]] }),
  );
  assert.ok(parsed);
  assert.equal(parsed.pubkey, ALICE_PUB);
  assert.equal(parsed.address, B_B.toLowerCase(), "address normalised");
  assert.equal(parsed.chain, "11155111");
  assert.equal(parsed.revoked, false);

  assert.equal(
    parseBindingRecord(bindingEvent({ kind: 37018 })),
    null,
    "wrong kind",
  );
  assert.equal(
    parseBindingRecord(bindingEvent({ d: `0x${"99".repeat(20)}` })),
    null,
    "a `d` that contradicts the address tag is refused",
  );
  assert.equal(
    parseBindingRecord(bindingEvent({ content: { address: B_A } })),
    null,
    "a content address that contradicts the tag is refused",
  );
  assert.equal(
    parseBindingRecord(bindingEvent({ address: "0xnope" })),
    null,
    "an unusable address is refused",
  );
  assert.equal(
    parseBindingRecord(bindingEvent({ content: { revoked: true } })).revoked,
    true,
    "a revocation is carried, never dropped",
  );
  const noJson = { ...bindingEvent(), content: "{" };
  assert.equal(
    parseBindingRecord(noJson),
    null,
    "unreadable content is refused",
  );
});

test("canonicalBindingByPubkey keeps the newest record per npub", () => {
  const older = parseBindingRecord(bindingEvent({ created_at: 100, id: "a1" }));
  const newer = parseBindingRecord(
    bindingEvent({ address: B_A, created_at: 200, id: "a2" }),
  );
  const byPubkey = canonicalBindingByPubkey([older, newer]);
  assert.equal(byPubkey.get(ALICE_PUB)?.address, B_A.toLowerCase());

  const live = parseBindingRecord(bindingEvent({ created_at: 100, id: "a1" }));
  const revoked = parseBindingRecord(
    bindingEvent({ created_at: 200, id: "a2", content: { revoked: true } }),
  );
  const afterRevoke = canonicalBindingByPubkey([live, revoked]);
  assert.equal(
    afterRevoke.get(ALICE_PUB)?.revoked,
    true,
    "a newer revocation closes the thread an older record opened",
  );
});
