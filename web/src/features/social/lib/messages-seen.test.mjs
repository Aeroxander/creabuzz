import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SEEN_PEERS,
  freshSeen,
  hasUnreadMessages,
  newestIncoming,
  newestIncomingOf,
  parseSeen,
  withListSeen,
  withPeerSeen,
} from "./messages-seen.ts";

const ME = "a".repeat(64);
const ALICE = "b".repeat(64);
const BOB = "c".repeat(64);

const conversation = (peer, messages) => ({ peer, messages });
const from = (who, at) => ({ from: who, at });

test("nothing is new without a record, and nothing older than the record's start is new", () => {
  const inbox = [conversation(ALICE, [from(ALICE, 100)])];
  assert.equal(hasUnreadMessages(inbox, null), false);
  assert.equal(hasUnreadMessages(inbox, freshSeen(100)), false);
  assert.equal(hasUnreadMessages(inbox, freshSeen(99)), true);
});

test("only the other person's messages count; what the reader sent is never new", () => {
  const seen = freshSeen(50);
  assert.equal(
    hasUnreadMessages([conversation(ALICE, [from(ME, 200)])], seen),
    false,
  );
  assert.equal(newestIncoming(conversation(ALICE, [from(ME, 200)])), 0);
  assert.equal(
    newestIncoming(conversation(ALICE, [from(ALICE, 120), from(ME, 200)])),
    120,
  );
});

test("opening a conversation reads it, and only it", () => {
  const inbox = [
    conversation(ALICE, [from(ALICE, 100)]),
    conversation(BOB, [from(BOB, 110)]),
  ];
  let seen = withPeerSeen(freshSeen(10), ALICE, 100);
  assert.equal(hasUnreadMessages(inbox, seen), true, "Bob's is still new");
  seen = withPeerSeen(seen, BOB, 110);
  assert.equal(hasUnreadMessages(inbox, seen), false);
  // A newer message from Alice is new again.
  inbox[0] = conversation(ALICE, [from(ALICE, 100), from(ALICE, 130)]);
  assert.equal(hasUnreadMessages(inbox, seen), true);
});

test("seeing the inbox list reads everything its previews showed", () => {
  const inbox = [
    conversation(ALICE, [from(ALICE, 100)]),
    conversation(BOB, [from(BOB, 110)]),
  ];
  const seen = withListSeen(freshSeen(10), newestIncomingOf(inbox));
  assert.equal(newestIncomingOf(inbox), 110);
  assert.equal(hasUnreadMessages(inbox, seen), false);
});

test("seen times never move back", () => {
  const seen = withPeerSeen(withListSeen(freshSeen(10), 200), ALICE, 300);
  assert.equal(withListSeen(seen, 100), seen);
  assert.equal(withPeerSeen(seen, ALICE, 250), seen);
  assert.equal(withPeerSeen(seen, ALICE, 301).peers[ALICE], 301);
});

test("a record read back from the browser keeps only what is well formed, and at most the newest conversations", () => {
  assert.equal(parseSeen(null), null);
  assert.equal(parseSeen("not json"), null);
  assert.equal(parseSeen(JSON.stringify({ list: 3 })), null);
  assert.deepEqual(
    parseSeen(
      JSON.stringify({
        since: 5,
        list: "x",
        peers: { [ALICE]: 7, nothex: 9, [BOB]: -1 },
      }),
    ),
    { since: 5, list: 0, peers: { [ALICE]: 7 } },
  );

  const many = {};
  for (let i = 0; i < MAX_SEEN_PEERS + 20; i += 1)
    many[i.toString(16).padStart(64, "0")] = i;
  const parsed = parseSeen(JSON.stringify({ since: 1, list: 0, peers: many }));
  assert.equal(Object.keys(parsed.peers).length, MAX_SEEN_PEERS);
  // The oldest reads went; the newest stayed.
  assert.equal(parsed.peers["0".repeat(64)], undefined);
  assert.equal(
    parsed.peers[(MAX_SEEN_PEERS + 19).toString(16).padStart(64, "0")],
    MAX_SEEN_PEERS + 19,
  );
});
