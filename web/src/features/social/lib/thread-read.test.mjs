import assert from "node:assert/strict";
import test from "node:test";

import { installFakeRelay } from "../../../shared/lib/fake-relay-socket.mjs";

/**
 * What a post's page costs the reader, counted on the production `fetchThread` and the production `queryEvents` /
 * `queryEventsMulti` over a scripted relay (`fake-relay-socket.mjs`): every socket is a connection, a handshake and a
 * sign-in to a server that can be far away, so the counts are the guard. Remove the batched ancestor read, the shared
 * socket or the climb over what was already read and a count below fails.
 */

const NSEC = "22".repeat(32);
const WS = "ws://relay.test:3000";

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  },
};
store.set("buzz.identity.nsec", NSEC);

const { fetchThread, MAX_ANCESTORS } = await import("./thread-read.ts");
const { queryEvents } = await import("../../../shared/lib/nostr-client.ts");
const { buildRows } = await import("./timeline.ts");
const { relayFailureOutcome } = await import(
  "../../../shared/lib/relay-failure.ts"
);

const hex = (n) => n.toString(16).padStart(2, "0").repeat(32);
const AUTHOR = hex(0xaa);

/** A kind 1 note answering `parent` in the thread rooted at `root` (NIP-10 markers); a top-level post when null. */
function note(n, { root = null, parent = null, at = 1000 + n } = {}) {
  const tags = [];
  if (root) tags.push(["e", hex(root), "", "root"]);
  if (parent && parent !== root) tags.push(["e", hex(parent), "", "reply"]);
  return {
    id: hex(n),
    pubkey: AUTHOR,
    kind: 1,
    created_at: at,
    tags,
    content: `note ${n}`,
    sig: "s".repeat(128),
  };
}

/** Root 1, then a chain 2 <- 3 <- ... <- depth+1 where every note names the root, plus two replies to the last. */
function conversation(depth) {
  const events = [note(1)];
  for (let n = 2; n <= depth + 1; n++) {
    events.push(note(n, { root: 1, parent: n - 1 }));
  }
  const focus = depth + 1;
  events.push(note(200, { root: 1, parent: focus }));
  events.push(note(201, { root: 1, parent: focus }));
  return { events, focus };
}

function relayWith(events, options = {}) {
  const relay = installFakeRelay({ events, ...options });
  relay.install();
  return relay;
}

/** The thread as the page read it before the batching: one socket per read, the climb one note at a time. */
async function referenceThread(noteId) {
  const read = (filter) => queryEvents(WS, filter);
  const [found] = await read({ ids: [noteId], kinds: [1], limit: 1 });
  const row = found ? (buildRows([found])[0] ?? null) : null;
  const rootId = row?.rootId ?? noteId;
  const [underRoot, underNote] = await Promise.all([
    read({ kinds: [1], "#e": [rootId], limit: 500 }),
    rootId === noteId
      ? Promise.resolve([])
      : read({ kinds: [1], "#e": [noteId], limit: 200 }),
  ]);
  const ancestors = [];
  let parentId = row?.replyToId ?? null;
  while (parentId && ancestors.length < MAX_ANCESTORS) {
    const [parent] = await read({ ids: [parentId], kinds: [1], limit: 1 });
    const up = parent ? buildRows([parent])[0] : null;
    if (!up) break;
    ancestors.unshift(up);
    parentId = up.replyToId;
  }
  const replies = buildRows([...underRoot, ...underNote]).filter(
    (r) => r.event.id !== noteId && r.replyToId !== null,
  );
  return { note: row, ancestors, replies, isRoot: row?.rootId == null };
}

test("a deep reply is read on two sockets in two steps, not one socket per note", async () => {
  const { events, focus } = conversation(4);
  const relay = relayWith(events);
  const thread = await fetchThread(WS, hex(focus));

  assert.deepEqual(
    thread.ancestors.map((a) => a.event.id),
    [hex(1), hex(2), hex(3), hex(4)],
    "the notes above, oldest first",
  );
  const stats = relay.stats();
  assert.equal(stats.sockets, 2, "one socket for the note, one for the rest");
  assert.equal(stats.serialHops, 2, "two connections, one after the other");
  assert.equal(stats.reqs, 2);
  assert.ok(
    relay.requests().every((filters) => filters.length > 1),
    "every read carries all of its filters in one REQ",
  );
});

test("a top-level post is read on one socket", async () => {
  const { events } = conversation(3);
  const relay = relayWith(events);
  const thread = await fetchThread(WS, hex(1));
  assert.equal(thread.isRoot, true);
  assert.equal(thread.note.event.id, hex(1));
  assert.equal(thread.ancestors.length, 0);
  assert.equal(thread.replies.length, 5);
  const stats = relay.stats();
  assert.equal(stats.sockets, 1);
  assert.equal(stats.serialHops, 1);
});

test("the climb reads from the server only for a link nothing already read holds", async () => {
  // 3 <- 2 <- 1 where note 2 carries no root tag (its only tag names note 1), so the read by root misses it and the
  // read of the root and parent by id still finds note 2 and note 1: no extra socket.
  const events = [
    note(1),
    { ...note(2), tags: [["e", hex(1), "", "reply"]] },
    note(3, { root: 1, parent: 2 }),
  ];
  const relay = relayWith(events);
  const thread = await fetchThread(WS, hex(3));
  assert.deepEqual(
    thread.ancestors.map((a) => a.event.id),
    [hex(1), hex(2)],
  );
  assert.equal(relay.stats().sockets, 2);

  // 5 <- 4 <- 3 <- 2 <- 1 where note 3 names only note 2: the focus's parent (4) and the root come with the second
  // read and note 2 with the read by root, but note 3 is in neither, so it is read once by id on a socket of its own.
  const gapped = [
    note(1),
    note(2, { root: 1, parent: 1 }),
    { ...note(3), tags: [["e", hex(2), "", "reply"]] },
    note(4, { root: 1, parent: 3 }),
    note(5, { root: 1, parent: 4 }),
  ];
  const gapRelay = relayWith(gapped);
  const deeper = await fetchThread(WS, hex(5));
  assert.deepEqual(
    deeper.ancestors.map((a) => a.event.id),
    [hex(1), hex(2), hex(3), hex(4)],
  );
  assert.equal(gapRelay.stats().sockets, 3, "a gap costs one more read");
});

test("the climb stays bounded however long the chain", async () => {
  // Nobody names the root, so every link above the note is a gap read one at a time: capped at MAX_ANCESTORS.
  const chain = [note(1)];
  for (let n = 2; n <= 30; n++) {
    chain.push({ ...note(n), tags: [["e", hex(n - 1), "", "reply"]] });
  }
  const events = [...chain, note(40, { root: 1, parent: 30 })];
  const relay = relayWith(events);
  const thread = await fetchThread(WS, hex(40));
  assert.equal(thread.ancestors.length, MAX_ANCESTORS);
  // 2 for the note and the replies, then the reads the climb could not avoid: never more than the cap.
  assert.ok(relay.stats().sockets <= 2 + MAX_ANCESTORS);
});

test("the page gets what it got before: same note, ancestors, replies and isRoot", async () => {
  const scenarios = [
    ["a top-level post", conversation(3).events, hex(1)],
    ["a reply to the root", conversation(1).events, hex(2)],
    ["a deep reply", conversation(5).events, hex(6)],
    ["a reply in the middle", conversation(5).events, hex(3)],
    [
      "a reply whose parent is gone",
      conversation(4).events.filter((e) => e.id !== hex(4)),
      hex(5),
    ],
    ["a reply whose root is gone", conversation(3).events.slice(1), hex(4)],
    ["a post nobody has", conversation(2).events, hex(99)],
    ["a chain longer than the cap", conversation(12).events, hex(13)],
  ];
  for (const [label, events, id] of scenarios) {
    relayWith(events);
    const before = await referenceThread(id);
    relayWith(events);
    const after = await fetchThread(WS, id);
    assert.deepEqual(after, before, label);
  }
});

test("a relay that sends an event once per filter that holds it changes nothing", async () => {
  const { events, focus } = conversation(3);
  relayWith(events, { dedupe: false });
  const twice = await fetchThread(WS, hex(focus));
  relayWith(events, { dedupe: true });
  const once = await fetchThread(WS, hex(focus));
  assert.deepEqual(twice, once);
});

test("a refusal is classified as before, on the first read and on the second", async () => {
  const { events, focus } = conversation(3);

  relayWith(events, { refuse: () => "auth-required: not authenticated" });
  await assert.rejects(fetchThread(WS, hex(focus)), (error) => {
    assert.equal(relayFailureOutcome(error), "auth-required");
    assert.match(error.message, /auth-required: not authenticated/);
    return true;
  });

  // The first read goes through; the second (by root) is refused: the page still sees the server's own words.
  relayWith(events, {
    refuse: (filters) =>
      filters.some((f) => f["#e"]?.[0] === hex(1))
        ? "restricted: not a channel member"
        : null,
  });
  await assert.rejects(fetchThread(WS, hex(focus)), (error) => {
    assert.equal(relayFailureOutcome(error), "answered");
    assert.match(error.message, /restricted: not a channel member/);
    return true;
  });
});
