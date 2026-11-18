import assert from "node:assert/strict";
import { test } from "node:test";

import { missingPostText, postRemoval } from "./removed-post.ts";

const POST = "a".repeat(64);

const entry = (overrides) => ({
  action: "remove",
  post: POST,
  thread: null,
  at: 100,
  reason: "",
  ...overrides,
});

test("a post the log says a moderator removed says so, with the newest reason", () => {
  const log = [
    entry({ at: 100, reason: "Old" }),
    entry({ at: 200, reason: " Spam link " }),
  ];
  assert.deepEqual(missingPostText(postRemoval(log, POST)), {
    headline: "A moderator removed this post.",
    reason: "Spam link",
  });
});

test("a removed reply, another post, or another action is not this post's removal", () => {
  const log = [
    entry({ thread: "t".repeat(64), reason: "reply" }),
    entry({ post: "b".repeat(64) }),
    entry({ action: "lock" }),
  ];
  assert.equal(postRemoval(log, POST), null);
  assert.deepEqual(missingPostText(null), {
    headline: "This post isn't here. It may have been deleted.",
    reason: null,
  });
});

test("a removal without a reason gives none", () => {
  assert.deepEqual(missingPostText(postRemoval([entry({})], POST)), {
    headline: "A moderator removed this post.",
    reason: null,
  });
});
