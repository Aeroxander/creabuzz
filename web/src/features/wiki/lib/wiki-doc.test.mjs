// Run with: node --experimental-strip-types --test src/features/wiki/lib/wiki-doc.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import {
  WikiDocSync,
  fromBase64,
  toBase64,
  wikiSyncUpdateFromEvent,
} from "./wiki-doc.ts";
import { commitLocalEdit, seedSnapshot } from "./text-edit.ts";

const KIND_WIKI_SYNC = 20003;

/**
 * A shared wire: every publish reaches every other attached transport's
 * receive handler (which is that peer's sync.handleRemoteUpdate). Mirrors the
 * relay fan-out the transport plugs into.
 */
class MockBus {
  constructor() {
    this.transports = [];
    this.publishCount = 0;
  }
  makeTransport() {
    const bus = this;
    const t = {
      receive: null,
      closed: false,
      published: [],
      publish(update) {
        bus.publishCount += 1;
        t.published.push(update);
        for (const other of bus.transports) {
          if (other === t || other.closed || !other.receive) continue;
          other.receive(update);
        }
      },
      close() {
        t.closed = true;
      },
    };
    this.transports.push(t);
    return t;
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wire a doc's sync to a transport so inbound updates flow back in. */
function connect(doc, bus, opts, author = "peer") {
  const transport = bus.makeTransport();
  const sync = new WikiDocSync(doc, transport, opts);
  transport.receive = (update) => sync.handleRemoteUpdate(author, update);
  sync.start();
  return { sync, transport };
}

// ── relay event envelope (decode / page filter) ─────────────────────────────

test("base64 roundtrips raw Yjs bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test("base64 roundtrips an empty payload", () => {
  assert.deepEqual(fromBase64(toBase64(new Uint8Array(0))), new Uint8Array(0));
});

test("fromBase64 rejects non-base64 input", () => {
  assert.equal(fromBase64("!!!not base64!!!"), null);
});

const decodeCases = [
  {
    name: "decodes a matching update for the page",
    event: {
      kind: KIND_WIKI_SYNC,
      tags: [["d", "home"]],
      content: toBase64(new Uint8Array([9, 9])),
    },
    expect: "bytes",
  },
  {
    name: "ignores a different kind",
    event: {
      kind: 44001,
      tags: [["d", "home"]],
      content: toBase64(new Uint8Array([1])),
    },
    expect: null,
  },
  {
    name: "ignores a different page slug",
    event: {
      kind: KIND_WIKI_SYNC,
      tags: [["d", "other"]],
      content: toBase64(new Uint8Array([1])),
    },
    expect: null,
  },
  {
    name: "ignores a missing page tag",
    event: {
      kind: KIND_WIKI_SYNC,
      tags: [["h", "chan"]],
      content: toBase64(new Uint8Array([1])),
    },
    expect: null,
  },
  {
    name: "ignores an empty page tag",
    event: {
      kind: KIND_WIKI_SYNC,
      tags: [["d", ""]],
      content: toBase64(new Uint8Array([1])),
    },
    expect: null,
  },
  {
    name: "ignores undecodable content",
    event: { kind: KIND_WIKI_SYNC, tags: [["d", "home"]], content: "@@@" },
    expect: null,
  },
  {
    name: "finds the page tag among several tags",
    event: {
      kind: KIND_WIKI_SYNC,
      tags: [
        ["h", "chan"],
        ["d", "home"],
      ],
      content: toBase64(new Uint8Array([7])),
    },
    expect: "bytes",
  },
];

for (const c of decodeCases) {
  test(`wikiSyncUpdateFromEvent: ${c.name}`, () => {
    const out = wikiSyncUpdateFromEvent(c.event, "home", KIND_WIKI_SYNC);
    if (c.expect === "bytes") {
      assert.ok(out instanceof Uint8Array, "expected decoded bytes");
    } else {
      assert.equal(out, null);
    }
  });
}

// ── WikiDocSync: convergence over the transport ─────────────────────────────

test("two seeded docs converge on a local edit over the transport", async () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const textA = docA.getText("content");
  const textB = docB.getText("content");

  // Deterministic seed: both open the SAME saved snapshot → one copy.
  const snapshotId = "snapshot-evt-1";
  seedSnapshot(textA, "Hello world", snapshotId);
  seedSnapshot(textB, "Hello world", snapshotId);
  assert.equal(textA.toString(), textB.toString(), "seeds agree before sync");

  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 10 }, "a");
  const b = connect(docB, bus, { throttleMs: 10 }, "b");

  docA.transact(() => {
    commitLocalEdit(textA, "Hello world", "Hello there world");
  }, "local");
  await settle(100);

  assert.equal(textA.toString(), "Hello there world");
  assert.equal(
    textB.toString(),
    "Hello there world",
    "doc B converges on A's edit via the transport",
  );
  a.sync.stop();
  b.sync.stop();
});

test("two peers editing different regions both converge", async () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const textA = docA.getText("content");
  const textB = docB.getText("content");
  seedSnapshot(textA, "one two three", "snap");
  seedSnapshot(textB, "one two three", "snap");

  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 5 }, "a");
  const b = connect(docB, bus, { throttleMs: 5 }, "b");

  docA.transact(
    () => commitLocalEdit(textA, "one two three", "ONE two three"),
    "local",
  );
  docB.transact(
    () => commitLocalEdit(textB, "one two three", "one two THREE"),
    "local",
  );
  await settle(120);

  assert.equal(
    textA.toString(),
    textB.toString(),
    "both docs settle to one copy",
  );
  a.sync.stop();
  b.sync.stop();
});

test("a remote update then a local edit both propagate", async () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const textA = docA.getText("content");
  const textB = docB.getText("content");
  seedSnapshot(textA, "s", "snap");
  seedSnapshot(textB, "s", "snap");

  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 5 }, "a");
  const b = connect(docB, bus, { throttleMs: 5 }, "b");

  docB.transact(() => commitLocalEdit(textB, "s", "sb"), "local");
  await settle(60);
  docA.transact(() => commitLocalEdit(textA, "sb", "sba"), "local");
  await settle(60);

  assert.equal(textB.toString(), "sba");
  a.sync.stop();
  b.sync.stop();
});

test("converged peers stop echoing (bounded publish count)", async () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const textA = docA.getText("content");
  const textB = docB.getText("content");
  seedSnapshot(textA, "base", "snap");
  seedSnapshot(textB, "base", "snap");

  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 5, echoMs: 5 }, "a");
  const b = connect(docB, bus, { throttleMs: 5, echoMs: 5 }, "b");

  docA.transact(() => commitLocalEdit(textA, "base", "changed"), "local");
  await settle(150);

  assert.equal(textB.toString(), "changed");
  assert.ok(
    bus.publishCount <= 4,
    `expected bounded publishes, got ${bus.publishCount}`,
  );
  a.sync.stop();
  b.sync.stop();
});

// ── WikiDocSync: throttle / batching bounds ────────────────────────────────

test("rapid local edits coalesce to a bounded number of publishes", async () => {
  const docA = new Y.Doc();
  const textA = docA.getText("content");
  seedSnapshot(textA, "t", "snap");

  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 60 }, "a");

  let rendered = "t";
  for (let i = 0; i < 10; i += 1) {
    const next = `t${i}`;
    docA.transact(() => commitLocalEdit(textA, rendered, next), "local");
    rendered = next;
    await settle(3);
  }
  await settle(150);

  assert.ok(
    bus.publishCount <= 3,
    `throttle bound violated: ${bus.publishCount} publishes for 10 edits`,
  );
  a.sync.stop();
});

test("edits inside one window merge into a single publish", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  seedSnapshot(text, "x", "snap");
  const bus = new MockBus();
  const a = connect(doc, bus, { throttleMs: 50 }, "a");

  doc.transact(() => commitLocalEdit(text, "x", "xa"), "local");
  doc.transact(() => commitLocalEdit(text, "xa", "xab"), "local");
  await settle(120);

  assert.equal(bus.publishCount, 1, "two edits in one window → one publish");
  a.sync.stop();
});

test("idle doc produces no publish", async () => {
  const doc = new Y.Doc();
  doc.getText("content");
  const bus = new MockBus();
  const a = connect(doc, bus, { throttleMs: 10 }, "a");
  await settle(60);
  assert.equal(bus.publishCount, 0, "no edits → no publish");
  a.sync.stop();
});

// ── WikiDocSync: remote apply / echo / teardown ────────────────────────────

test("applying an already-known update reports false and does not echo", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  seedSnapshot(text, "s", "snap");
  const bus = new MockBus();
  const a = connect(doc, bus, { throttleMs: 5, echoMs: 5 }, "a");

  const fresh = new Y.Doc();
  seedSnapshot(fresh.getText("content"), "s2", "snap");
  const update = Y.encodeStateAsUpdate(fresh);

  const first = a.sync.handleRemoteUpdate("peer", update);
  const second = a.sync.handleRemoteUpdate("peer", update);
  assert.equal(first, true, "a new update advances the doc");
  assert.equal(second, false, "a duplicate update advances nothing");
  await settle(80);
  // Only the first advance may trigger an echo, so at most one extra publish.
  assert.ok(bus.publishCount <= 1, `unexpected echo count ${bus.publishCount}`);
  a.sync.stop();
});

test("onRemoteChange and onPeerUpdate fire on a new remote update", async () => {
  const doc = new Y.Doc();
  doc.getText("content");
  let changes = 0;
  const authors = [];
  const transport = { publish() {}, close() {} };
  const sync = new WikiDocSync(doc, transport, {
    throttleMs: 5,
    onRemoteChange: () => {
      changes += 1;
    },
    onPeerUpdate: (author) => authors.push(author),
  });
  sync.start();

  const fresh = new Y.Doc();
  fresh.getText("content").insert(0, "hello");
  sync.handleRemoteUpdate("carol", Y.encodeStateAsUpdate(fresh));

  assert.equal(changes, 1, "remote change reported once");
  assert.deepEqual(authors, ["carol"], "peer author recorded");
  sync.stop();
});

test("a remote-origin update is not re-broadcast (echo loop guard)", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const bus = new MockBus();
  const a = connect(doc, bus, { throttleMs: 5 }, "a");

  // Simulate applying a remote update the way the sync does (origin "remote").
  const fresh = new Y.Doc();
  fresh.getText("content").insert(0, "hi");
  doc.transact(() => {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(fresh), "remote");
  }, "remote");
  await settle(60);

  assert.equal(bus.publishCount, 0, "remote-applied changes never publish");
  a.sync.stop();
});

test("stop() closes the transport and halts publishing", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  seedSnapshot(text, "x", "snap");
  const bus = new MockBus();
  const a = connect(doc, bus, { throttleMs: 5 }, "a");

  a.sync.stop();
  assert.equal(a.transport.closed, true, "transport closed on stop");

  doc.transact(() => commitLocalEdit(text, "x", "xy"), "local");
  await settle(40);
  assert.equal(bus.publishCount, 0, "no publish after stop");
});

test("start() is idempotent — a double start publishes once per edit", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  seedSnapshot(text, "x", "snap");
  const bus = new MockBus();
  const transport = bus.makeTransport();
  const sync = new WikiDocSync(doc, transport, { throttleMs: 30 });
  transport.receive = (u) => sync.handleRemoteUpdate("p", u);
  sync.start();
  sync.start();

  doc.transact(() => commitLocalEdit(text, "x", "xz"), "local");
  await settle(80);
  assert.equal(
    bus.publishCount,
    1,
    "one edit → one publish even after double start",
  );
  sync.stop();
});

test("a coalesced batch larger than the target is sent whole, never split", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  seedSnapshot(text, "x", "snap");
  const bus = new MockBus();
  // maxBatchBytes smaller than the merged update must NOT split/corrupt it.
  const a = connect(doc, bus, { throttleMs: 20, maxBatchBytes: 1 }, "a");

  doc.transact(
    () => commitLocalEdit(text, "x", "some much longer body"),
    "local",
  );
  await settle(80);

  assert.equal(
    bus.publishCount,
    1,
    "one merged update → one publish (no split)",
  );
  a.sync.stop();
});

// ── WikiDocSync: echo semantics for late joiners ───────────────────────────

test("a late joiner converges from a peer's full-state echo", async () => {
  const docA = new Y.Doc();
  const textA = docA.getText("content");
  seedSnapshot(textA, "early", "snap");

  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 5, echoMs: 10 }, "a");

  docA.transact(() => commitLocalEdit(textA, "early", "early work"), "local");
  await settle(30);

  const docC = new Y.Doc();
  const textC = docC.getText("content");
  seedSnapshot(textC, "early", "snap");
  const c = connect(docC, bus, { throttleMs: 5, echoMs: 10 }, "c");

  c.transport.publish(Y.encodeStateAsUpdate(docC));
  await settle(80);

  assert.equal(
    textC.toString(),
    "early work",
    "late joiner converges via echo",
  );
  a.sync.stop();
  c.sync.stop();
});

test("distinct peers are tracked separately via onPeerUpdate", async () => {
  const doc = new Y.Doc();
  doc.getText("content");
  const authors = [];
  const transport = { publish() {}, close() {} };
  const sync = new WikiDocSync(doc, transport, {
    throttleMs: 5,
    onPeerUpdate: (a) => authors.push(a),
  });
  sync.start();

  const mk = (text) => {
    const d = new Y.Doc();
    d.getText("content").insert(0, text);
    return Y.encodeStateAsUpdate(d);
  };
  sync.handleRemoteUpdate("ann", mk("from ann"));
  sync.handleRemoteUpdate("bob", mk("from bob too"));

  assert.equal(authors.length, 2, "both advancing updates recorded");
  assert.ok(authors.includes("ann") && authors.includes("bob"));
  sync.stop();
});

test("a duplicate remote update does not re-fire onRemoteChange", async () => {
  const doc = new Y.Doc();
  doc.getText("content");
  let changes = 0;
  const transport = { publish() {}, close() {} };
  const sync = new WikiDocSync(doc, transport, {
    throttleMs: 5,
    onRemoteChange: () => {
      changes += 1;
    },
  });
  sync.start();

  const d = new Y.Doc();
  d.getText("content").insert(0, "dup");
  const update = Y.encodeStateAsUpdate(d);
  sync.handleRemoteUpdate("p", update);
  sync.handleRemoteUpdate("p", update);

  assert.equal(changes, 1, "only the advancing update reports a change");
  sync.stop();
});

test("default throttle coalesces a burst into one publish", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  seedSnapshot(text, "z", "snap");
  const bus = new MockBus();
  const a = connect(doc, bus, {}, "a");

  for (let i = 0; i < 5; i += 1) {
    doc.transact(() => commitLocalEdit(text, `z${i}`, `z${i + 1}`), "local");
    await settle(2);
  }
  await settle(250);

  assert.ok(
    bus.publishCount <= 2,
    `default throttle should coalesce, got ${bus.publishCount}`,
  );
  a.sync.stop();
});

test("publish delivers raw update bytes the peer can apply", async () => {
  const docA = new Y.Doc();
  const textA = docA.getText("content");
  seedSnapshot(textA, "q", "snap");
  const bus = new MockBus();
  const a = connect(docA, bus, { throttleMs: 10 }, "a");

  docA.transact(() => commitLocalEdit(textA, "q", "qa"), "local");
  await settle(60);

  assert.equal(a.transport.published.length, 1, "one publish for one edit");
  const sent = a.transport.published[0];
  assert.ok(sent instanceof Uint8Array && sent.length > 0, "publishes bytes");

  // The published bytes are a delta from the shared seeded base: a peer that
  // started from the same snapshot converges to the edited text by applying it.
  const docZ = new Y.Doc();
  seedSnapshot(docZ.getText("content"), "q", "snap");
  Y.applyUpdate(docZ, sent);
  assert.equal(docZ.getText("content").toString(), "qa");
  a.sync.stop();
});

test("decode: matching kind and slug with empty content yields empty bytes", () => {
  const out = wikiSyncUpdateFromEvent(
    { kind: KIND_WIKI_SYNC, tags: [["d", "home"]], content: "" },
    "home",
    KIND_WIKI_SYNC,
  );
  assert.ok(out instanceof Uint8Array, "empty content decodes to empty bytes");
  assert.equal(out.length, 0);
});
