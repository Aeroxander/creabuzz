import assert from "node:assert/strict";
import test from "node:test";

import { KEPT_FOR_MS, keptKey, sendOnce, templatePrint } from "./send-once.ts";

const ME = "a".repeat(64);
const TEMPLATE = { kind: 47003, tags: [["task-part", "task"]], content: "{}" };

/** A fake browser store, signer and server. */
function world() {
  const kept = new Map();
  const server = new Map();
  let signs = 0;
  const w = {
    kept,
    server,
    get signs() {
      return signs;
    },
    /** How the next publish goes: "ok", "lost" (arrives, answer lost), "down" (never arrives), "refused". */
    next: "ok",
    store: {
      get: (key) => kept.get(key) ?? null,
      set: (key, value) => kept.set(key, value),
      remove: (key) => kept.delete(key),
    },
    sign: async (template) => {
      signs += 1;
      return {
        ...template,
        id: signs.toString(16).padStart(64, "0"),
        pubkey: ME,
        created_at: 100 + signs,
        sig: "sig",
      };
    },
    publish: async (event) => {
      const how = w.next;
      w.next = "ok";
      if (how === "down") throw new Error("offline");
      if (how === "refused") return { accepted: false, message: "blocked: no" };
      server.set(event.id, event);
      if (how === "lost") throw new Error("Server publish timed out");
      return { accepted: true };
    },
    exists: async (id) => server.has(id),
  };
  return w;
}
const send = (w, over = {}) =>
  sendOnce({
    key: "make:offer-1",
    signer: ME,
    template: TEMPLATE,
    store: w.store,
    sign: w.sign,
    publish: w.publish,
    exists: w.exists,
    ...over,
  });

test("a send that goes through leaves nothing kept", async () => {
  const w = world();
  const sent = await send(w);
  assert.equal(sent.adopted, false);
  assert.equal(w.server.size, 1);
  assert.equal(w.kept.size, 0);
});

test("a send whose answer was lost is carried on by the retry, not made again", async () => {
  const w = world();
  w.next = "lost";
  await assert.rejects(send(w), /timed out/);
  // The record is kept, and it is on the server.
  assert.equal(w.kept.size, 1);
  assert.equal(w.server.size, 1);
  const again = await send(w);
  assert.equal(again.adopted, true);
  assert.equal(w.server.size, 1);
  assert.equal(w.signs, 1);
  assert.equal(w.kept.size, 0);
});

test("different words are a different send: they are never swallowed by, or thrown away for, what was kept", async () => {
  const w = world();
  w.next = "lost";
  await assert.rejects(send(w));
  // A second task (or a changed draft) under the same action: it is signed and sent as itself.
  const other = { ...TEMPLATE, content: '{"other":1}' };
  const second = await send(w, { template: other });
  assert.equal(second.adopted, false);
  assert.equal(second.event.content, '{"other":1}');
  assert.equal(w.server.size, 2);
  assert.notEqual(keptKey("make", other), keptKey("make", TEMPLATE));
  assert.notEqual(templatePrint(other), templatePrint(TEMPLATE));
  // The first words are still carried on when they are tried again.
  const first = await send(w);
  assert.equal(first.adopted, true);
  assert.equal(first.event.content, "{}");
  assert.equal(w.server.size, 2);
});

test("the same work handed in again after it went through is a new record", async () => {
  const w = world();
  await send(w);
  const again = await send(w);
  assert.equal(again.adopted, false);
  assert.equal(w.server.size, 2);
});

test("a send that never arrived sends the very same record again", async () => {
  const w = world();
  w.next = "down";
  await assert.rejects(send(w), /offline/);
  assert.equal(w.server.size, 0);
  const again = await send(w);
  assert.equal(again.adopted, false);
  assert.equal(w.signs, 1);
  assert.deepEqual([...w.server.keys()], ["0".repeat(63) + "1"]);
});

test("nothing is sent while the server cannot be asked about the kept record", async () => {
  const w = world();
  w.next = "lost";
  await assert.rejects(send(w));
  let published = 0;
  await assert.rejects(
    send(w, {
      exists: async () => {
        throw new Error("cannot read");
      },
      publish: async () => {
        published += 1;
        return { accepted: true };
      },
    }),
    /cannot read/,
  );
  assert.equal(published, 0);
  assert.equal(w.kept.size, 1);
});

test("a refusal is an answer: the kept record is dropped", async () => {
  const w = world();
  w.next = "refused";
  await assert.rejects(send(w), /blocked: no/);
  assert.equal(w.kept.size, 0);
  assert.equal(w.server.size, 0);
});

test("a record kept by another account, or one that cannot be read, is never sent or adopted", async () => {
  const w = world();
  w.next = "lost";
  await assert.rejects(send(w));
  const other = await send(w, {
    signer: "b".repeat(64),
    sign: async (template) => ({
      ...template,
      id: "9".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      sig: "s",
    }),
  });
  assert.equal(other.adopted, false);
  assert.equal(other.event.id, "9".repeat(64));

  const broken = world();
  const key = keptKey("make:offer-1", TEMPLATE);
  broken.kept.set(key, "{not json");
  assert.equal((await send(broken)).adopted, false);
  broken.kept.set(key, JSON.stringify({ print: "x", event: { id: "nope" } }));
  assert.equal((await send(broken)).adopted, false);
});

test("a record kept long ago is asked about before it is dropped: adopted if it arrived, signed afresh if not", async () => {
  // It arrived, and the answer was lost; the retry comes a day later. The server is asked, and the record stands.
  const landed = world();
  landed.next = "lost";
  await assert.rejects(send(landed, { now: () => 1_000 }));
  const late = await send(landed, { now: () => 1_000 + 24 * KEPT_FOR_MS });
  assert.equal(late.adopted, true);
  assert.equal(landed.server.size, 1);

  // It never arrived. Within the hour the same record goes again; after it, the words are signed afresh.
  const soon = world();
  soon.next = "down";
  await assert.rejects(send(soon, { now: () => 1_000 }));
  await send(soon, { now: () => 1_000 + KEPT_FOR_MS });
  assert.equal(soon.signs, 1);
  const old = world();
  old.next = "down";
  await assert.rejects(send(old, { now: () => 1_000 }));
  await send(old, { now: () => 1_001 + KEPT_FOR_MS });
  assert.equal(old.signs, 2);
  assert.equal(old.server.size, 1);
  assert.equal(old.kept.size, 0);
});
