import assert from "node:assert/strict";
import test from "node:test";

import {
  getAgentPubkey,
  peekAgentPubkey,
  resetAgentIdentity,
} from "./agent-identity.ts";

/**
 * The identity module reads the browser's `localStorage`. Install a minimal
 * stand-in so the reset/read contract can be exercised under `node --test`.
 */
function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
  return store;
}

const KEY = "buzz.agent.nsec";

test("peekAgentPubkey reports an absent key without creating one", () => {
  const store = installStorage();
  assert.equal(peekAgentPubkey(), null);
  assert.equal(store.has(KEY), false, "a read must not materialize a key");
});

test("getAgentPubkey creates the key on first use", () => {
  const store = installStorage();
  const pubkey = getAgentPubkey();
  assert.equal(typeof pubkey, "string");
  assert.ok(store.get(KEY), "first use persists a signing key");
  assert.equal(peekAgentPubkey(), pubkey, "peek reads the same identity");
});

test("resetAgentIdentity retires the key and a read does not resurrect it", () => {
  const store = installStorage();
  getAgentPubkey(); // materialize a key
  resetAgentIdentity();
  assert.equal(store.has(KEY), false, "reset removes the stored key");
  // The regression this pins: a read after a reset must not lazily create a
  // fresh key. The fleet view reads the pubkey to display it, so a
  // materializing read would silently undo the reset.
  assert.equal(peekAgentPubkey(), null);
  assert.equal(store.has(KEY), false, "peek after reset must not recreate it");
});
