// The path from a peer's message to the live document, against the
// production `receiveIntoDoc` with real signatures: an unsigned or non-member
// update must never change the document.
// Run with: node --experimental-strip-types --test src/features/wiki/lib/live-apply.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import * as Y from "yjs";

import { receiveIntoDoc } from "./live-apply.ts";
import {
  bytesToBase64,
  createLiveReceiver,
  liveRoomId,
  signEnvelope,
} from "./live-auth.ts";
import { createMemberDirectory } from "./live-members.ts";
import { PeerBook } from "./live-peers.ts";

const ROOM = liveRoomId("standup");
const NOW = 1_800_000_000;

function person(peerId) {
  const secret = generateSecretKey();
  return {
    peerId,
    pubkey: getPublicKey(secret),
    sign: async (template) => finalizeEvent(template, secret),
  };
}

const alice = person("peer-alice");
const bob = person("peer-bob");
const mallory = person("peer-mallory");

/** A doc holding `text`, and the Yjs update that produced it. */
function authored(text) {
  const doc = new Y.Doc();
  let update = new Uint8Array();
  doc.on("update", (bytes) => {
    update = bytes;
  });
  doc.getText("content").insert(0, text);
  return { doc, update };
}

const signedBy = (who, update) =>
  signEnvelope({
    room: ROOM,
    peer: who.peerId,
    update,
    sign: who.sign,
    nowSecs: NOW,
  });

/** Receiver side for a peer whose community is `members`. */
function reader(members) {
  const doc = new Y.Doc();
  const book = new PeerBook();
  const directory = createMemberDirectory({
    fetchMembers: async () => new Set(members),
    nowMs: () => NOW * 1000,
  });
  const receiver = createLiveReceiver({
    room: ROOM,
    members: directory,
    nowMs: () => NOW * 1000,
  });
  const receive = (data, peerId, isCancelled) =>
    receiveIntoDoc({ doc, receiver, book, data, peerId, isCancelled });
  return { doc, book, receive, text: () => doc.getText("content").toString() };
}

test("a member's signed update is applied and the peer becomes verified", async () => {
  const me = reader([alice.pubkey, bob.pubkey]);
  const { update } = authored("Standup notes");
  const result = await me.receive(await signedBy(alice, update), alice.peerId);
  assert.deepEqual(result, {
    accepted: true,
    advanced: true,
    newlyVerified: true,
    signer: alice.pubkey,
  });
  assert.equal(me.text(), "Standup notes");
  assert.deepEqual(me.book.verifiedPeerIds(), [alice.peerId]);
});

test("an UNSIGNED update (the old wire format) never changes the document", async () => {
  const me = reader([alice.pubkey]);
  const { update } = authored("<script>stranger was here</script>");
  for (const data of [
    update,
    update.buffer.slice(0),
    { update: bytesToBase64(update) },
  ]) {
    const result = await me.receive(data, "peer-stranger");
    assert.deepEqual(result, { accepted: false, reason: "unsigned" });
  }
  assert.equal(me.text(), "");
  assert.equal(me.book.verifiedCount, 0);
});

test("a validly signed update from a NON-member never changes the document", async () => {
  const me = reader([alice.pubkey]);
  const { update } = authored("Buy my token");
  const result = await me.receive(
    await signedBy(mallory, update),
    mallory.peerId,
  );
  assert.deepEqual(result, { accepted: false, reason: "not-member" });
  assert.equal(me.text(), "");
  assert.equal(me.book.isVerified(mallory.peerId), false);
});

test("nothing is applied when there is no member list to check against", async () => {
  const doc = new Y.Doc();
  const book = new PeerBook();
  const receiver = createLiveReceiver({
    room: ROOM,
    members: createMemberDirectory({
      fetchMembers: async () => null,
      nowMs: () => NOW * 1000,
    }),
    nowMs: () => NOW * 1000,
  });
  const { update } = authored("hello");
  const result = await receiveIntoDoc({
    doc,
    receiver,
    book,
    data: await signedBy(alice, update),
    peerId: alice.peerId,
  });
  assert.deepEqual(result, { accepted: false, reason: "membership-unknown" });
  assert.equal(doc.getText("content").toString(), "");
});

test("a member's envelope relayed by a stranger is refused (peer binding)", async () => {
  const me = reader([alice.pubkey]);
  const { update } = authored("genuine");
  const captured = await signedBy(alice, update);
  const replay = await me.receive(captured, mallory.peerId);
  assert.deepEqual(replay, { accepted: false, reason: "wrong-peer" });
  assert.equal(me.text(), "");
  assert.equal(
    me.book.isVerified(mallory.peerId),
    false,
    "no state is sent to the relayer",
  );
});

test("an update altered after signing is refused", async () => {
  const me = reader([alice.pubkey]);
  const honest = authored("honest").update;
  const evil = authored("evil").update;
  const env = await signedBy(alice, honest);
  const result = await me.receive(
    { ...env, update: bytesToBase64(evil) },
    alice.peerId,
  );
  assert.deepEqual(result, { accepted: false, reason: "bad-signature" });
  assert.equal(me.text(), "");
});

test("a member's hello verifies the peer without changing the document", async () => {
  const me = reader([alice.pubkey]);
  const hello = await signedBy(alice, Y.encodeStateAsUpdate(new Y.Doc()));
  const result = await me.receive(hello, alice.peerId);
  assert.equal(result.accepted, true);
  assert.equal(result.advanced, false);
  assert.equal(result.newlyVerified, true);
  assert.equal(me.text(), "");
});

test("a member who signs bytes that are not a Yjs update is refused", async () => {
  const me = reader([alice.pubkey]);
  const result = await me.receive(
    await signedBy(alice, new Uint8Array([255, 255, 255, 255, 1, 2, 3])),
    alice.peerId,
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "bad-update");
  assert.equal(me.text(), "");
});

test("a message that arrives after the document is gone is not applied", async () => {
  const me = reader([alice.pubkey]);
  const { update } = authored("late");
  const result = await me.receive(
    await signedBy(alice, update),
    alice.peerId,
    () => true,
  );
  assert.deepEqual(result, { accepted: false, reason: "cancelled" });
  assert.equal(me.text(), "");
  assert.equal(me.book.verifiedCount, 0);
});

test("two members' documents converge; a stranger in the room changes nothing", async () => {
  const members = [alice.pubkey, bob.pubkey];
  const a = reader(members);
  const b = reader(members);
  const aliceDoc = authored("From Alice. ");
  const bobDoc = authored("From Bob. ");
  const strangerDoc = authored("From a stranger. ");

  // Everyone broadcasts to everyone in the room.
  for (const [who, sent] of [
    [alice, aliceDoc.update],
    [bob, bobDoc.update],
    [mallory, strangerDoc.update],
  ]) {
    const env = await signedBy(who, sent);
    if (who !== alice) await a.receive(env, who.peerId);
    if (who !== bob) await b.receive(env, who.peerId);
  }
  // Each side also applies its own edit locally.
  Y.applyUpdate(a.doc, aliceDoc.update);
  Y.applyUpdate(b.doc, bobDoc.update);

  assert.equal(a.text(), b.text(), "members converge");
  assert.match(a.text(), /From Alice\./);
  assert.match(a.text(), /From Bob\./);
  assert.doesNotMatch(a.text(), /stranger/);
  assert.doesNotMatch(b.text(), /stranger/);
  assert.equal(a.book.isVerified(mallory.peerId), false);
});

test("production wiring: wiki-sync routes peers through receiveIntoDoc and sends only signed envelopes", () => {
  const source = readFileSync(
    new URL("../wiki-sync.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /receiveIntoDoc\(/);
  assert.match(source, /signEnvelope\(/);
  // No direct write of peer bytes into the doc, and no raw-bytes send.
  assert.doesNotMatch(source, /applyPeerUpdate/);
  assert.doesNotMatch(source, /Y\.applyUpdate/);
  assert.doesNotMatch(source, /toUint8|sendBuffer/);
  // Content goes to verified peers only, never a room-wide broadcast.
  assert.match(source, /book\.verifiedPeerIds\(\)/);
  assert.doesNotMatch(source, /send\(\s*envelope\s*\)/);
});
