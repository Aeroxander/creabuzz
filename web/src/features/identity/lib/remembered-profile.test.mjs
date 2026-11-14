import assert from "node:assert/strict";
import test from "node:test";

import {
  readRememberedProfile,
  REMEMBERED_PROFILE_KEY,
  rememberProfile,
} from "./remembered-profile.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

function store() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

test("a profile is remembered for its own account, trimmed, with only what it has", () => {
  const s = store();
  rememberProfile(s, {
    pubkey: A,
    name: "  Mira Okafor ",
    about: " makes films ",
    picture: " https://x.test/m.png ",
  });
  assert.deepEqual(readRememberedProfile(s, A), {
    pubkey: A,
    name: "Mira Okafor",
    about: "makes films",
    picture: "https://x.test/m.png",
  });
  rememberProfile(s, { pubkey: A, name: "Mira", about: "  " });
  assert.deepEqual(readRememberedProfile(s, A), { pubkey: A, name: "Mira" });
});

test("another account on the same browser never reads it, and a malformed one is nothing", () => {
  const s = store();
  rememberProfile(s, { pubkey: A, name: "Mira" });
  assert.equal(readRememberedProfile(s, B), null);
  for (const bad of [
    "not json",
    "{}",
    JSON.stringify({ pubkey: A, name: "  " }),
    JSON.stringify({ pubkey: A, name: 5 }),
  ]) {
    s.setItem(REMEMBERED_PROFILE_KEY, bad);
    assert.equal(readRememberedProfile(s, A), null, bad);
  }
});

test("an empty name, or a key that is not a key, remembers nothing", () => {
  const s = store();
  rememberProfile(s, { pubkey: A, name: "   " });
  rememberProfile(s, { pubkey: "short", name: "Mira" });
  assert.equal(s.items.size, 0);
});

test("a newer profile replaces the older one", () => {
  const s = store();
  rememberProfile(s, { pubkey: A, name: "Mira" });
  rememberProfile(s, { pubkey: A, name: "Mira O.", about: "films" });
  assert.deepEqual(readRememberedProfile(s, A), {
    pubkey: A,
    name: "Mira O.",
    about: "films",
  });
});

test("a storage that throws remembers nothing and breaks nothing", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.doesNotThrow(() =>
    rememberProfile(broken, { pubkey: A, name: "Mira" }),
  );
  assert.equal(readRememberedProfile(broken, A), null);
});
