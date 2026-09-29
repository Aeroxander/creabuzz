/**
 * `graduation-progress.ts` under `node --test`: the stored graduation hash
 * must never become the reason a graduation cannot start.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { graduationTxStore } from "./graduation-progress.ts";

const HASH = `0x${"ab".repeat(32)}`;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    map,
  };
}

function blockedStorage() {
  const deny = () => {
    throw new DOMException("denied", "SecurityError");
  };
  return { getItem: deny, setItem: deny, removeItem: deny };
}

describe("graduationTxStore", () => {
  it("round-trips a confirmed hash and drops a corrupt entry", () => {
    const storage = memoryStorage();
    const store = graduationTxStore("0xauction", storage);
    assert.equal(store.load(), null);
    store.save(HASH);
    assert.equal(store.load(), HASH);
    storage.map.set("buzz:launchpad:graduation-tx:0xauction", "garbage");
    assert.equal(store.load(), null);
    assert.equal(storage.map.size, 0, "the corrupt entry is removed");
  });

  it("refuses to persist a malformed hash", () => {
    assert.throws(() => graduationTxStore("x", memoryStorage()).save("0x12"));
  });

  it("reads blocked storage as unknown instead of throwing", () => {
    const store = graduationTxStore("0xauction", blockedStorage());
    assert.equal(store.load(), null);
    assert.doesNotThrow(() => store.clear());
    // save still reports the failure so the caller can decide.
    assert.throws(() => store.save(HASH), /denied/);
  });

  describe("when reading localStorage itself throws", () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete globalThis.localStorage;
    });

    it("creating the default store does not throw (Safari/Brave blocked data)", () => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
      const store = graduationTxStore("0xauction");
      assert.equal(store.load(), null);
    });
  });
});
