import assert from "node:assert/strict";
import { test } from "node:test";
import {
  challengeDraftKey,
  loadChallengeDraft,
  saveChallengeDraft,
} from "./challenge-draft.ts";

const memory = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    data,
  };
};

test("a draft is kept per lock, wallet and milestone, whatever the case of the addresses", () => {
  const a = challengeDraftKey("0xAAAA", "0xBBBB", 1);
  assert.equal(a, challengeDraftKey("0xaaaa", "0xbbbb", 1));
  assert.notEqual(a, challengeDraftKey("0xaaaa", "0xbbbb", 2));
  assert.notEqual(a, challengeDraftKey("0xaaaa", "0xcccc", 1));
  assert.notEqual(a, challengeDraftKey("0xdddd", "0xbbbb", 1));
});

test("what was typed comes back, and an empty draft is forgotten", () => {
  const store = memory();
  const key = challengeDraftKey("0xaa", "0xbb", 0);
  assert.equal(loadChallengeDraft(key, store), "");
  saveChallengeDraft(key, "Live at https://beta.example.org", store);
  assert.equal(
    loadChallengeDraft(key, store),
    "Live at https://beta.example.org",
  );
  saveChallengeDraft(key, "   ", store);
  assert.equal(store.data.size, 0);
  assert.equal(loadChallengeDraft(key, store), "");
});

test("storage that is missing or throws never breaks the screen", () => {
  assert.equal(loadChallengeDraft("k", null), "");
  assert.doesNotThrow(() => saveChallengeDraft("k", "text", null));
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  assert.equal(loadChallengeDraft("k", broken), "");
  assert.doesNotThrow(() => saveChallengeDraft("k", "text", broken));
});
