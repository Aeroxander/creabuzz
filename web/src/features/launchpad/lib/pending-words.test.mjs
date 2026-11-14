import assert from "node:assert/strict";
import test from "node:test";

import {
  dropPending,
  keepPending,
  MAX_PENDING_WORDS,
  PENDING_WORDS_KEY,
  pendingFull,
  pendingIn,
  pendingScope,
} from "./pending-words.ts";

function memory() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
  };
}

const scope = pendingScope({
  relay: "wss://Relay.example",
  chainId: 31337,
  author: "AB".repeat(32),
  launchId: "docs",
  account: "CD".repeat(32),
});
const job = (id, check = "the guide is in Spanish", revision = `r-${id}`) => ({
  scope,
  mandate: `0x${"b1".repeat(20)}`,
  id,
  check,
  createdAt: 1,
  revision,
});

test("a job is kept until its words are accepted, and survives a new read of the storage", () => {
  const storage = memory();
  assert.equal(keepPending(storage, job("0xa")), "kept");
  // What a reload sees: the same storage, read again.
  assert.deepEqual(
    pendingIn(storage, scope).map((j) => j.id),
    ["0xa"],
  );
  dropPending(storage, job("0xa"));
  assert.deepEqual(pendingIn(storage, scope), []);
});

test("jobs belong to one server, network, project and account", () => {
  const storage = memory();
  keepPending(storage, job("0xa"));
  const otherAccount = pendingScope({
    relay: "wss://relay.example",
    chainId: 31337,
    author: "ab".repeat(32),
    launchId: "docs",
    account: "ef".repeat(32),
  });
  assert.deepEqual(pendingIn(storage, otherAccount), []);
  assert.equal(pendingIn(storage, scope).length, 1);
});

test("a full list refuses a new work area and never evicts one that is still unpublished", () => {
  const storage = memory();
  for (let i = 0; i < MAX_PENDING_WORDS; i++)
    assert.equal(keepPending(storage, job(`0x${i.toString(16)}`)), "kept");
  assert.equal(pendingFull(storage), true);
  // The 51st is refused, and says so; the first, still unpublished, is still there.
  assert.equal(keepPending(storage, job("0xnew")), "full");
  const ids = pendingIn(storage, scope).map((j) => j.id);
  assert.equal(ids.length, MAX_PENDING_WORDS);
  assert.ok(ids.includes("0x0"));
  assert.ok(!ids.includes("0xnew"));
  // Correcting the words of a work area already waiting takes no new room, so it is still allowed.
  assert.equal(
    keepPending(storage, job("0x0", "corrected", "r-0x0-2")),
    "kept",
  );
  assert.equal(
    pendingIn(storage, scope).find((j) => j.id === "0x0")?.check,
    "corrected",
  );
  // Publishing one frees room for the next.
  dropPending(storage, job("0x1"));
  assert.equal(keepPending(storage, job("0xnew")), "kept");
});

test("a slower publish of older words does not remove the newer words that replaced them", () => {
  const storage = memory();
  const earlier = job("0xa", "earlier words", "r-1");
  const corrected = job("0xa", "corrected words", "r-2");
  keepPending(storage, earlier);
  keepPending(storage, corrected);
  // The earlier words' publish completes last: it acknowledges only its own revision.
  dropPending(storage, earlier);
  assert.deepEqual(
    pendingIn(storage, scope).map((j) => [j.check, j.revision]),
    [["corrected words", "r-2"]],
  );
  dropPending(storage, corrected);
  assert.deepEqual(pendingIn(storage, scope), []);
});

test("storage that refuses keeps every job it already had, and says the new one was not kept", () => {
  const storage = memory();
  keepPending(storage, job("0xa"));
  const refusing = {
    getItem: storage.getItem,
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(keepPending(refusing, job("0xb")), "unavailable");
  assert.deepEqual(
    pendingIn(storage, scope).map((j) => j.id),
    ["0xa"],
  );
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(keepPending(broken, job("0xa")), "unavailable");
  assert.deepEqual(pendingIn(broken, scope), []);
  const garbage = memory();
  garbage.setItem(PENDING_WORDS_KEY, "{not json");
  assert.deepEqual(pendingIn(garbage, scope), []);
  garbage.setItem(PENDING_WORDS_KEY, JSON.stringify([{ scope }, 7, null]));
  assert.deepEqual(pendingIn(garbage, scope), []);
});

test("jobs saved before jobs had a revision (D91) are kept, given one, and published through the current reader", () => {
  const storage = memory();
  // The list exactly as D91 wrote it: no revision.
  const legacy = {
    scope,
    mandate: `0x${"b1".repeat(20)}`,
    id: "0xa",
    check: "the guide is in Spanish",
    createdAt: 1_700_000_000_000,
  };
  storage.setItem(PENDING_WORDS_KEY, JSON.stringify([legacy]));
  const [found] = pendingIn(storage, scope);
  assert.equal(found.check, legacy.check);
  assert.equal(typeof found.revision, "string");
  // Written back with that revision, and read the same again.
  assert.equal(
    JSON.parse(storage.getItem(PENDING_WORDS_KEY))[0].revision,
    found.revision,
  );
  assert.deepEqual(pendingIn(storage, scope), [found]);
  // A retry publishes it and acknowledges that revision: the job goes.
  dropPending(storage, found);
  assert.deepEqual(pendingIn(storage, scope), []);
});

test("a legacy job whose migration cannot be written keeps its words and the same revision on every read", () => {
  const items = new Map();
  const legacy = {
    scope,
    mandate: `0x${"b1".repeat(20)}`,
    id: "0xa",
    check: "the guide is in Spanish",
    createdAt: 1_700_000_000_000,
  };
  items.set(PENDING_WORDS_KEY, JSON.stringify([legacy]));
  const readOnly = {
    getItem: (key) => items.get(key) ?? null,
    setItem: () => {
      throw new Error("storage refused");
    },
  };
  const first = pendingIn(readOnly, scope);
  const again = pendingIn(readOnly, scope);
  assert.equal(first.length, 1);
  assert.equal(first[0].check, legacy.check);
  assert.equal(first[0].revision, again[0].revision);
  // Still stored as it was: nothing was dropped.
  assert.deepEqual(JSON.parse(items.get(PENDING_WORDS_KEY)), [legacy]);
});

test("newer words saved over a legacy job are not removed by the legacy job's late acknowledgement", () => {
  const storage = memory();
  storage.setItem(
    PENDING_WORDS_KEY,
    JSON.stringify([
      {
        scope,
        mandate: `0x${"b1".repeat(20)}`,
        id: "0xa",
        check: "old words",
        createdAt: 1,
      },
    ]),
  );
  const [old] = pendingIn(storage, scope);
  keepPending(storage, job("0xa", "new words", "r-new"));
  dropPending(storage, old);
  assert.deepEqual(
    pendingIn(storage, scope).map((j) => j.check),
    ["new words"],
  );
});
