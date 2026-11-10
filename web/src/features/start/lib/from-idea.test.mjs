import assert from "node:assert/strict";
import { test } from "node:test";

import {
  carryOnIssue,
  clearIdea,
  handOffIdea,
  keptFromIdea,
  peekIdea,
  RECORD_UNREAD_MESSAGE,
  recordCarryingOver,
} from "./from-idea.ts";

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

test("a hand-off is kept until cleared, and only for the server it was made on", () => {
  const store = memory();
  handOffIdea(store, { ...idea, server: "wss://one.example" });
  // A reload reads it again: it is not used up by reading.
  assert.equal(peekIdea(store, me, "wss://one.example")?.id, "idea-1");
  assert.equal(peekIdea(store, me, "wss://one.example")?.id, "idea-1");
  // Another server's form, or another account, does not get it.
  assert.equal(peekIdea(store, me, "wss://two.example"), null);
  assert.equal(peekIdea(store, "b".repeat(64), "wss://one.example"), null);
  clearIdea(store);
  assert.equal(peekIdea(store, me, "wss://one.example"), null);
});

test("a project that cannot carry on stops with the reason, and never becomes a second project", () => {
  const ok = { name: "Nebula", own: { isIdea: true }, everRemoved: false };
  assert.equal(carryOnIssue(ok), null);
  assert.match(
    carryOnIssue({ ...ok, own: null }),
    /^Nebula is no longer on this server.*Nothing was made\./,
  );
  assert.match(
    carryOnIssue({ ...ok, own: { isIdea: false } }),
    /^Nebula already has Shares or a sale set up\. Nothing was made\./,
  );
  assert.match(
    carryOnIssue({ ...ok, everRemoved: true }),
    /removed earlier.*Nothing was made\./,
  );
});

test("the record is published over what the server has now: cover, topic, story and rooms are carried over", async () => {
  const chat = { team: "t", supporters: "s", backers: null, board: null };
  const input = { id: "nebula", name: "Nebula", stage: "graduated" };
  // The project without Shares that is being carried on.
  assert.deepEqual(
    await recordCarryingOver(input, async () => ({
      image: "https://x/y.png",
      category: "Games",
      longPitch: "The story",
      chat,
    })),
    {
      ...input,
      image: "https://x/y.png",
      category: "Games",
      longPitch: "The story",
      chat,
    },
  );
  // The same project, already published once by a try whose answer was lost: trying again keeps the board it made.
  const withBoard = { ...chat, board: "b" };
  const again = await recordCarryingOver(input, async () => ({
    image: "https://x/y.png",
    category: null,
    longPitch: null,
    chat: withBoard,
  }));
  assert.deepEqual(again.chat, withBoard);
  assert.equal(again.image, "https://x/y.png");
  // What the form itself sets wins over what was there.
  const named = await recordCarryingOver(
    { ...input, chat: { ...chat, board: "new" } },
    async () => ({ image: null, category: null, longPitch: null, chat }),
  );
  assert.equal(named.chat.board, "new");
  // Nothing under the id yet: the record as the form made it.
  assert.deepEqual(await recordCarryingOver(input, async () => null), input);
});

test("when the founder's record cannot be read, nothing is published: the step fails with a way to try again", async () => {
  await assert.rejects(
    recordCarryingOver({ id: "nebula" }, async () => {
      throw new Error("socket closed");
    }),
    (error) => error.message === RECORD_UNREAD_MESSAGE,
  );
  assert.match(RECORD_UNREAD_MESSAGE, /was not published.*Try again\.$/);
});
