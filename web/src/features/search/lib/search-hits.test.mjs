import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMUNITY_SEARCH_KINDS,
  hitTarget,
  hitText,
  ROOM_SEARCH_KINDS,
} from "./search-hits.ts";

test("board posts and their replies are searched with the rooms", () => {
  assert.ok(ROOM_SEARCH_KINDS.includes(45001));
  assert.ok(ROOM_SEARCH_KINDS.includes(45003));
  // Votes are not words anyone searches for.
  assert.ok(!ROOM_SEARCH_KINDS.includes(45002));
  // Board posts live under a board, never in the community as a whole.
  assert.ok(!COMMUNITY_SEARCH_KINDS.includes(45001));
});

test("a board post opens itself, and a reply opens the post it is under", () => {
  const post = "a".repeat(64);
  assert.deepEqual(hitTarget({ id: post, kind: 45001, tags: [["h", "b"]] }), {
    label: "board post",
    post,
  });
  // A direct reply carries only a `reply` mark; a nested one names the post as `root`.
  assert.equal(
    hitTarget({
      id: "c1",
      kind: 45003,
      tags: [
        ["h", "b"],
        ["e", post, "", "reply"],
      ],
    }).post,
    post,
  );
  assert.equal(
    hitTarget({
      id: "c2",
      kind: 45003,
      tags: [
        ["h", "b"],
        ["e", post, "", "root"],
        ["e", "c1", "", "reply"],
      ],
    }).post,
    post,
  );
  assert.equal(hitTarget({ id: "c3", kind: 45003, tags: [] }).post, undefined);
});

test("wiki pages, tasks and chat messages keep their targets", () => {
  assert.deepEqual(hitTarget({ id: "w", kind: 44001, tags: [["d", "plan"]] }), {
    label: "wiki page",
    view: "wiki",
    id: "plan",
  });
  assert.equal(hitTarget({ id: "t", kind: 44011, tags: [] }).view, "work");
  assert.deepEqual(hitTarget({ id: "m", kind: 9, tags: [["h", "r"]] }), {
    label: "message",
  });
});

test("a board post's heading mark is not shown", () => {
  assert.equal(
    hitText({ kind: 45001, content: "# Creaton launch\n\nWords" }),
    "Creaton launch\n\nWords",
  );
  assert.equal(hitText({ kind: 9, content: "# not a title" }), "# not a title");
});

test("a board post hit has its title on its own, apart from the words under it", async () => {
  const { hitParts } = await import("./search-hits.ts");
  assert.deepEqual(
    hitParts({
      kind: 45001,
      content:
        "# Plant guide for community gardens\n\nA short guide to what grows.",
    }),
    {
      title: "Plant guide for community gardens",
      excerpt: "A short guide to what grows.",
    },
  );
  // A message has no title: all of it is the excerpt, a heading mark and all.
  assert.deepEqual(hitParts({ kind: 9, content: "# not a title" }), {
    title: null,
    excerpt: "# not a title",
  });
  // A post that is only a title.
  assert.deepEqual(hitParts({ kind: 45001, content: "# Just this" }), {
    title: "Just this",
    excerpt: "",
  });
});
