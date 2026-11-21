// A repost names the original by its id and carries no copy of it, so deleting the original leaves no readable copy behind.
// Run with: node --experimental-strip-types --test src/social/post-events.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { buildRepost } from "./post-events.ts";

test("a repost carries the original's id and author and none of its words", () => {
  const note = {
    id: "b".repeat(64),
    pubkey: "c".repeat(64),
    kind: 1,
    content: "words that must go when the post is deleted",
    created_at: 1,
    tags: [],
    sig: "d".repeat(128),
  };
  const repost = buildRepost(note);
  assert.equal(repost.kind, 6);
  assert.deepEqual(repost.tags, [
    ["e", note.id],
    ["p", note.pubkey],
  ]);
  assert.equal(repost.content, "");
  assert.ok(!JSON.stringify(repost).includes("words that must go"));
});
