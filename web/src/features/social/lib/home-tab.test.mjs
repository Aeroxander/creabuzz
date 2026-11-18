import assert from "node:assert/strict";
import { test } from "node:test";

import {
  homeTab,
  homeTabSearch,
  rememberHomeTab,
  storedHomeTab,
} from "./home-tab.ts";

const memory = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
};
const refusing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

test("Home opens on the feed of project records for everyone, signed in or not", () => {
  assert.equal(homeTab({ asked: undefined, stored: null }), "updates");
});

test("a tab in the address wins over the pick, and the pick wins over the landing", () => {
  assert.equal(homeTab({ asked: "boards", stored: "everyone" }), "boards");
  assert.equal(homeTab({ asked: undefined, stored: "everyone" }), "everyone");
  assert.equal(homeTab({ asked: "updates", stored: "everyone" }), "updates");
});

test("a pick is kept for that person on that server only", () => {
  const store = memory();
  assert.equal(storedHomeTab(store, "host:ana"), null);
  rememberHomeTab(store, "host:ana", "everyone");
  assert.equal(storedHomeTab(store, "host:ana"), "everyone");
  // Someone else signing in on the same browser, or the same person on another server, starts on the landing.
  assert.equal(storedHomeTab(store, "host:ben"), null);
  assert.equal(storedHomeTab(store, "other:ana"), null);
  // A visitor has no pick to keep.
  rememberHomeTab(store, null, "boards");
  assert.equal(storedHomeTab(store, null), null);
  assert.equal(storedHomeTab(store, "host:ana"), "everyone");
});

test("a note that is not a tab, or a browser that refuses, reads as no pick", () => {
  const store = memory();
  store.setItem("creaton.home.tab", '{"scope":"host:ana","tab":"prices"}');
  assert.equal(storedHomeTab(store, "host:ana"), null);
  store.setItem("creaton.home.tab", "not json");
  assert.equal(storedHomeTab(store, "host:ana"), null);
  assert.equal(storedHomeTab(refusing, "host:ana"), null);
  assert.equal(storedHomeTab(null, "host:ana"), null);
  assert.doesNotThrow(() => rememberHomeTab(refusing, "host:ana", "boards"));
});

test("the address is bare only for the tab the bare address opens on", () => {
  // The pick was kept: the bare address opens on it.
  assert.deepEqual(homeTabSearch("everyone", "everyone"), {});
  // Nothing was kept (a visitor, or a browser that refused): the tab rides in the address, except the landing.
  assert.deepEqual(homeTabSearch("everyone", null), { tab: "everyone" });
  assert.deepEqual(homeTabSearch("updates", null), {});
  // Going back to Updates after picking it: kept, so bare.
  assert.deepEqual(homeTabSearch("updates", "updates"), {});
});
