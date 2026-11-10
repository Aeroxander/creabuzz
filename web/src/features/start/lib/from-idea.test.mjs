import assert from "node:assert/strict";
import { test } from "node:test";

import { clearIdea, handOffIdea, peekIdea, keptFromIdea } from "./from-idea.ts";

/** What the form does: read it, then clear it. */
function takeIdea(store, me) {
  const got = peekIdea(store, me);
  clearIdea(store);
  return got;
}

function memory() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

const me = "a".repeat(64);
const idea = {
  id: "idea-1",
  author: me,
  name: "Garden guide",
  pitch: "A plain guide for community gardens.",
};

test("the idea's own founder gets its words once, and a later visit starts empty", () => {
  const store = memory();
  handOffIdea(store, idea);
  // Reading twice (a render run twice) still finds it; clearing is what ends it.
  assert.deepEqual(peekIdea(store, me), idea);
  assert.deepEqual(takeIdea(store, me), idea);
  assert.equal(takeIdea(store, me), null);
  assert.equal(store.size(), 0);
});

test("someone else's idea never fills this person's form", () => {
  const store = memory();
  handOffIdea(store, idea);
  assert.equal(takeIdea(store, "b".repeat(64)), null);
  assert.equal(store.size(), 0);
  handOffIdea(store, idea);
  assert.equal(takeIdea(store, null), null);
});

test("words longer than the form takes are cut to fit", () => {
  const store = memory();
  handOffIdea(store, {
    ...idea,
    name: "n".repeat(200),
    pitch: "p".repeat(500),
  });
  const got = takeIdea(store, me);
  assert.equal(got?.name.length, 60);
  assert.equal(got?.pitch.length, 140);
});

test("a broken entry or refused storage reads as nothing", () => {
  const store = memory();
  store.setItem("creaton.start.from-idea", "{not json");
  assert.equal(takeIdea(store, me), null);
  const refusing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.doesNotThrow(() => handOffIdea(refusing, idea));
  assert.equal(takeIdea(refusing, me), null);
  assert.doesNotThrow(() => clearIdea(refusing));
  assert.equal(takeIdea(undefined, me), null);
});

test("a project that sets up Shares keeps its cover, topic, story and rooms", () => {
  const chat = { team: "t", supporters: "s", backers: null, board: null };
  assert.deepEqual(
    keptFromIdea({
      image: "https://x/y.png",
      category: "Games",
      longPitch: null,
      chat,
    }),
    { image: "https://x/y.png", category: "Games", chat },
  );
  assert.deepEqual(
    keptFromIdea({ image: null, category: null, longPitch: "The story", chat }),
    { longPitch: "The story", chat },
  );
});
