import assert from "node:assert/strict";
import test from "node:test";

import { indexRoster, parseAnnouncement, rosterKey } from "./index-roster.ts";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);

function announcement(pubkey, id, createdAt, body = {}) {
  return {
    pubkey,
    created_at: createdAt,
    tags: [["d", id]],
    content: JSON.stringify({ name: `agent-${id}`, ...body }),
  };
}

test("an entry cannot be shadowed by another author using the same id", () => {
  // Addressable events are identified by (kind, pubkey, d); keying on `d` alone
  // let any member take over another agent's directory entry.
  const roster = indexRoster([
    announcement(ALICE, "buzz-tabs", 100, { name: "Alice's agent" }),
    announcement(MALLORY, "buzz-tabs", 200, { name: "Mallory's agent" }),
  ]);
  assert.equal(Object.keys(roster).length, 2);
  assert.equal(roster[rosterKey(ALICE, "buzz-tabs")]?.name, "Alice's agent");
  assert.equal(
    roster[rosterKey(MALLORY, "buzz-tabs")]?.name,
    "Mallory's agent",
  );
});

test("the newest heartbeat wins per author and id", () => {
  const roster = indexRoster([
    announcement(ALICE, "buzz-tabs", 100, { status: "available" }),
    announcement(ALICE, "buzz-tabs", 200, { status: "busy" }),
  ]);
  assert.equal(Object.keys(roster).length, 1);
  assert.equal(roster[rosterKey(ALICE, "buzz-tabs")]?.status, "busy");
  assert.equal(roster[rosterKey(ALICE, "buzz-tabs")]?.updatedAt, 200_000);
});

test("an announcement without a d tag is identified by its author", () => {
  const entry = parseAnnouncement({
    pubkey: ALICE,
    created_at: 100,
    tags: [],
    content: JSON.stringify({ name: "no id" }),
  });
  assert.equal(entry?.id, ALICE);
  assert.ok(entry);
  assert.equal(rosterKey(ALICE, entry.id), `${ALICE}:${ALICE}`);
});

test("malformed content still yields a usable entry", () => {
  const entry = parseAnnouncement({
    pubkey: ALICE,
    created_at: 100,
    tags: [["d", "buzz-tabs"]],
    content: "not json",
  });
  assert.equal(entry?.name, "buzz-tabs");
  assert.equal(entry?.runtype, "sandbox");
  assert.equal(entry?.heartbeat, 100_000);
});
