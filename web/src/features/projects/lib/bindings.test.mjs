// Binding records (kind:37017): what parses, and how a record merges with
// the viewer's local SIWE binding to produce the seat map the summon
// composer refuses on.
//
// Precedence under test: local (viewer) > record (teammate) > absent, where
// absent is still a loud blocker — `composeSummon` is driven directly below
// so removing the record source re-breaks the test rather than passing it.
import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBindingByPubkey,
  KIND_EVM_BINDING,
  parseBindingRecord,
} from "./bindings.ts";
import { composeSummon, localBindingMap } from "./summon-composer.ts";

const FOUNDER_PUB = "a".repeat(64);
const ALICE_PUB = "b".repeat(64);
const STRANGER_PUB = "7".repeat(64);
const B_A = `0x${"11".repeat(20)}`;
const B_B = `0x${"22".repeat(20)}`;
const B_LOCAL = `0x${"33".repeat(20)}`;

function seat(pubkey, slug, label, pct, source = "grant") {
  return {
    pubkey,
    role: { slug, label, pct },
    pct,
    source,
    eventId: `ev-${slug}`,
  };
}

const MAP = [
  seat(FOUNDER_PUB, "founder", "The founder", 40, "declared"),
  seat(ALICE_PUB, "writer", "The writer", 12),
];
const ORG = { nodeId: "nebula", orgName: "Nebula", orgSymbol: "NEB" };
const WITHIN = { budget: 1_000_000n, requiredCurrencyRaised: 6_000_000n };

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

test("records fill the team, local wins for the viewer, absent stays absent", () => {
  const records = [
    // Alice's current record …
    parseBindingRecord(
      bindingEvent({
        pubkey: ALICE_PUB,
        address: B_B,
        created_at: 100,
        id: "r-alice",
      }),
    ),
    // … and an older address of hers, which must not resurface.
    parseBindingRecord(
      bindingEvent({
        pubkey: ALICE_PUB,
        address: B_A,
        created_at: 50,
        id: "r-alice-old",
      }),
    ),
    // The viewer's own seat, as the relay remembers it (local beats it).
    parseBindingRecord(
      bindingEvent({
        pubkey: FOUNDER_PUB,
        address: B_A,
        created_at: 60,
        id: "r-founder",
      }),
    ),
    // A stranger's binding: off the map.
    parseBindingRecord(
      bindingEvent({
        pubkey: STRANGER_PUB,
        address: B_A,
        created_at: 70,
        id: "r-stranger",
      }),
    ),
  ].filter(Boolean);

  const map = localBindingMap(
    { pubkey: FOUNDER_PUB, address: B_LOCAL },
    MAP,
    records,
  );
  assert.equal(
    map.get(FOUNDER_PUB),
    B_LOCAL,
    "local beats the record for the viewer's own seat",
  );
  assert.equal(
    map.get(ALICE_PUB),
    B_B.toLowerCase(),
    "the teammate's record fills their seat (newest record wins)",
  );
  assert.equal(map.has(STRANGER_PUB), false, "off-map records are ignored");
  assert.equal(map.size, 2);
});

test("with no records the map is exactly the local-only one it used to be", () => {
  assert.equal(localBindingMap(null, MAP).size, 0, "no binding, no address");
  assert.deepEqual(
    [...localBindingMap({ pubkey: FOUNDER_PUB, address: B_LOCAL }, MAP)],
    [[FOUNDER_PUB, B_LOCAL]],
  );
  assert.equal(
    localBindingMap({ pubkey: FOUNDER_PUB, address: "0xnope" }, MAP).size,
    0,
    "a malformed local address is still not a binding",
  );
  const revokedOnly = [
    parseBindingRecord(
      bindingEvent({
        pubkey: ALICE_PUB,
        created_at: 200,
        id: "r-revoked",
        content: { revoked: true },
      }),
    ),
  ].filter(Boolean);
  assert.equal(
    localBindingMap(null, MAP, revokedOnly).size,
    0,
    "a revoked record never resolves a seat",
  );
});

test("a record resolves the seat the composer otherwise refuses", () => {
  const records = [
    parseBindingRecord(bindingEvent({ pubkey: ALICE_PUB, address: B_B })),
  ].filter(Boolean);

  const withoutRecords = composeSummon(
    MAP,
    localBindingMap({ pubkey: FOUNDER_PUB, address: B_LOCAL }, MAP),
    WITHIN,
    ORG,
  );
  assert.equal(withoutRecords.ok, false, "the unbound seat still blocks");
  assert.equal(withoutRecords.callData, null, "no bytes for a blocked map");
  assert.ok(
    withoutRecords.blockers.some((line) =>
      line.includes("no bound EVM address"),
    ),
    JSON.stringify(withoutRecords.blockers),
  );

  const withRecords = composeSummon(
    MAP,
    localBindingMap({ pubkey: FOUNDER_PUB, address: B_LOCAL }, MAP, records),
    WITHIN,
    ORG,
  );
  assert.equal(withRecords.ok, true, JSON.stringify(withRecords.blockers));
  assert.deepEqual(withRecords.blockers, []);
  assert.deepEqual(
    withRecords.initHolders,
    [B_LOCAL, B_B],
    "viewer's local address first, the record's second",
  );
  assert.equal(
    withRecords.initHolders.length,
    MAP.length,
    "every declared seat minted to a proved address",
  );
});
