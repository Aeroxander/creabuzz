// The room's tags on the feed's builders (plan section 4.1): a room post, reply and like carry the project's `a` tag and
// the room's `t` tag and nothing else that names a project; the old callers (no `room`) are unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPost,
  buildReply,
  buildVote,
  inAnyRoom,
  roomKeyOf,
  roomTagValue,
} from "./feed-events.ts";

const FOUNDER = "ab".repeat(32);
const KEY = `0x${"cd".repeat(32)}`;
const ROOM = { launch: { pubkey: FOUNDER, id: "lantern" }, key: KEY };
const COORD = `37001:${FOUNDER}:lantern`;
const root = {
  id: "11".repeat(32),
  pubkey: "22".repeat(32),
  kind: 1,
  created_at: 1,
  tags: [
    ["a", COORD],
    ["t", `room:${KEY}`],
  ],
  content: "hello",
};

test("a room post carries the project and the room, and no naddr in its text", () => {
  const post = buildPost({ text: "Hello #lamps", room: ROOM });
  assert.deepEqual(post.tags, [
    ["t", "lamps"],
    ["a", COORD],
    ["t", `room:${KEY}`],
  ]);
  assert.equal(post.content, "Hello #lamps");
});

test("a post with no room is what it was: the naddr line and no room tag", () => {
  const post = buildPost({
    text: "About it",
    launch: { pubkey: FOUNDER, id: "lantern" },
  });
  assert.ok(post.content.includes("nostr:naddr"));
  assert.equal(
    post.tags.some((t) => String(t[1]).startsWith("room:")),
    false,
  );
});

test("a room reply and a room like carry the same two tags", () => {
  const reply = buildReply({ text: "Yes", root, parent: root, room: ROOM });
  assert.deepEqual(
    reply.tags.filter((t) => t[0] === "a" || t[0] === "t"),
    [
      ["a", COORD],
      ["t", `room:${KEY}`],
    ],
  );
  const vote = buildVote({ target: root, direction: "+", room: ROOM });
  assert.deepEqual(vote.tags, [
    ["e", root.id],
    ["p", root.pubkey],
    ["k", "1"],
    ["a", COORD],
    ["t", `room:${KEY}`],
  ]);
});

test("a room reply never carries a second project tag from its root", () => {
  const other = { ...root, tags: [...root.tags, ["a", `37001:${FOUNDER}:other`]] };
  const reply = buildReply({ text: "Yes", root: other, parent: other, room: ROOM });
  assert.equal(reply.tags.filter((t) => t[0] === "a").length, 1);
});

test("the room key must be a chain key", () => {
  assert.throws(() => roomTagValue("0xabc"));
  assert.throws(() =>
    buildPost({ text: "x", room: { ...ROOM, key: "room" } }),
  );
});

test("the room of an event is read from its tag, and a topic never looks like it", () => {
  assert.equal(roomKeyOf(root), KEY);
  assert.equal(roomKeyOf({ tags: [["t", "room"]] }), null);
  assert.equal(roomKeyOf({ tags: [["t", "room:nope"]] }), null);
  assert.equal(inAnyRoom({ tags: [["t", "room:nope"]] }), true);
  assert.equal(inAnyRoom({ tags: [["t", "lamps"]] }), false);
});
