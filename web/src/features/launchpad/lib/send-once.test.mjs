import assert from "node:assert/strict";
import test from "node:test";

import { KEPT_FOR_MS, sendOnce, templatePrint } from "./send-once.ts";

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
  assert.equal(again.changed, false);
  assert.equal(w.server.size, 1);
  assert.equal(w.signs, 1);
  assert.equal(w.kept.size, 0);
});

test("the retry after a lost answer adopts the first record even when the words were changed since", async () => {
  const w = world();
  w.next = "lost";
  await assert.rejects(send(w));
  const again = await send(w, {
    template: { ...TEMPLATE, content: '{"other":1}' },
  });
  assert.equal(again.adopted, true);
  assert.equal(again.changed, true);
  assert.equal(again.event.content, "{}");
  assert.equal(w.server.size, 1);
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

test("changed words after a send that never arrived are signed afresh", async () => {
  const w = world();
  w.next = "down";
  await assert.rejects(send(w));
  const changed = { ...TEMPLATE, content: '{"other":1}' };
  const again = await send(w, { template: changed });
  assert.equal(w.signs, 2);
  assert.equal(again.event.content, '{"other":1}');
  assert.equal(w.server.size, 1);
  assert.notEqual(templatePrint(changed), templatePrint(TEMPLATE));
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
  broken.kept.set("make:offer-1", "{not json");
  assert.equal((await send(broken)).adopted, false);
  broken.kept.set(
    "make:offer-1",
    JSON.stringify({ print: "x", event: { id: "nope" } }),
  );
  assert.equal((await send(broken)).adopted, false);
});

test("a record kept long ago is a try given up: it is dropped, not adopted in place of a new send", async () => {
  const w = world();
  w.next = "lost";
  await assert.rejects(send(w, { now: () => 1_000 }));
  assert.equal(w.server.size, 1);
  // Within the hour it is the same try.
  const soon = world();
  soon.next = "lost";
  await assert.rejects(send(soon, { now: () => 1_000 }));
  assert.equal(
    (await send(soon, { now: () => 1_000 + KEPT_FOR_MS })).adopted,
    true,
  );
  // Later it is a new send, with a record of its own.
  const later = await send(w, { now: () => 1_001 + KEPT_FOR_MS });
  assert.equal(later.adopted, false);
  assert.equal(w.server.size, 2);
  assert.equal(w.kept.size, 0);
});
