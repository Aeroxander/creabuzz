import assert from "node:assert/strict";
import test from "node:test";

import {
  dropPending,
  keepPending,
  MAX_PENDING_WORDS,
  PENDING_WORDS_KEY,
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
const job = (id, check = "the guide is in Spanish") => ({
  scope,
  mandate: `0x${"b1".repeat(20)}`,
  id,
  check,
  createdAt: 1,
});

test("a job is kept until its words are accepted, and survives a new read of the storage", () => {
  const storage = memory();
  assert.equal(keepPending(storage, job("0xa")), true);
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
  // The scope ignores case, as addresses and keys do.
  assert.equal(pendingIn(storage, scope.toUpperCase().toLowerCase()).length, 1);
});

test("newer words for the same work area replace older ones, and the list is bounded", () => {
  const storage = memory();
  keepPending(storage, job("0xa", "first words"));
  keepPending(storage, job("0xa", "corrected words"));
  assert.deepEqual(
    pendingIn(storage, scope).map((j) => j.check),
    ["corrected words"],
  );
  for (let i = 0; i < MAX_PENDING_WORDS + 5; i++)
    keepPending(storage, job(`0x${i.toString(16)}`));
  assert.equal(
    JSON.parse(storage.items.get(PENDING_WORDS_KEY)).length,
    MAX_PENDING_WORDS,
  );
});

test("storage that refuses or holds garbage is not a crash, and says the job was not kept", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(keepPending(broken, job("0xa")), false);
  assert.deepEqual(pendingIn(broken, scope), []);
  const garbage = memory();
  garbage.setItem(PENDING_WORDS_KEY, "{not json");
  assert.deepEqual(pendingIn(garbage, scope), []);
  garbage.setItem(PENDING_WORDS_KEY, JSON.stringify([{ scope }, 7, null]));
  assert.deepEqual(pendingIn(garbage, scope), []);
});
