import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { inTurn, readFresh, RECORD_NOT_SHOWN_YET } from "./own-record-queue.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A server holding one record, slow to answer, and a change that is read, merge, publish. */
function world() {
  let stored = { createdAt: 1, listing: null, team: [] };
  const change = async (merge) => {
    const read = { ...stored };
    await tick();
    stored = { ...read, ...merge(read), createdAt: read.createdAt + 1 };
  };
  return { change, record: () => stored };
}

test("two changes pressed together both land: the second reads what the first published", async () => {
  const w = world();
  const queue = new Map();
  await Promise.all([
    inTurn("k", () => w.change(() => ({ listing: "unlisted" })), queue),
    inTurn("k", () => w.change((r) => ({ team: [...r.team, "ann"] })), queue),
  ]);
  assert.equal(w.record().listing, "unlisted");
  assert.deepEqual(w.record().team, ["ann"]);
  assert.equal(w.record().createdAt, 3);
  // Without taking turns the same two changes lose one: this is the defect the queue is for.
  const loose = world();
  await Promise.all([
    loose.change(() => ({ listing: "unlisted" })),
    loose.change((r) => ({ team: [...r.team, "ann"] })),
  ]);
  assert.equal(loose.record().listing, null);
});

test("a change that fails is its caller's failure and does not stop the next one", async () => {
  const queue = new Map();
  const order = [];
  const first = inTurn(
    "k",
    async () => {
      await tick();
      order.push("first");
      throw new Error("refused");
    },
    queue,
  );
  const second = inTurn(
    "k",
    async () => {
      order.push("second");
      return "done";
    },
    queue,
  );
  await assert.rejects(first, /refused/);
  assert.equal(await second, "done");
  assert.deepEqual(order, ["first", "second"]);
});

test("different records do not wait for each other, and a finished queue is forgotten", async () => {
  const queue = new Map();
  const order = [];
  const slow = inTurn(
    "a",
    async () => {
      await tick();
      await tick();
      order.push("a");
    },
    queue,
  );
  const quick = inTurn("b", async () => void order.push("b"), queue);
  await Promise.all([slow, quick]);
  assert.deepEqual(order, ["b", "a"]);
  await tick();
  assert.equal(queue.size, 0);
});

test("a read that still shows the record from before the last save is asked again, then refused", async () => {
  const sleep = async () => undefined;
  let calls = 0;
  const lagging = async () => {
    calls += 1;
    return { createdAt: calls < 3 ? 10 : 11 };
  };
  assert.deepEqual(await readFresh(lagging, 11, { sleep }), { createdAt: 11 });
  assert.equal(calls, 3);
  // Never shown: nothing is handed back to publish over.
  await assert.rejects(
    readFresh(async () => ({ createdAt: 10 }), 11, { sleep, tries: 3 }),
    (error) => error.message === RECORD_NOT_SHOWN_YET,
  );
  await assert.rejects(
    readFresh(async () => null, 11, { sleep, tries: 2 }),
    (error) => error.message === RECORD_NOT_SHOWN_YET,
  );
  // With no save of this tab's to wait for, the first answer is the answer, a missing record included.
  assert.equal(await readFresh(async () => null, undefined, { sleep }), null);
});

test("every change to an own record goes through the queue and the fresh read", () => {
  const source = readFileSync(
    new URL("../use-own-record.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /return inTurn\(key, async \(\) => \{/);
  assert.match(
    source,
    /await readFresh\(\s*\(\) => fetchOwnRecord\(me, launchId\),\s*lastSaved\.get\(key\),?\s*\)/,
  );
  assert.match(source, /lastSaved\.set\(key, signed\.created_at\)/);
  // Nothing else in the app publishes a merged own record without it.
  assert.equal(source.match(/fetchOwnRecord\(/g).length, 1);
});
