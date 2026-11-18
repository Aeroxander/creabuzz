import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReplyTree, countReplies } from "./thread-tree.ts";

const row = (id, at, replyToId, rootId = "root") => ({
  event: {
    id,
    pubkey: "a".repeat(64),
    kind: 1,
    created_at: at,
    tags: [],
    content: id,
    sig: "s",
  },
  replyToId,
  rootId,
});
const shape = (nodes) =>
  nodes.map((n) =>
    n.children.length ? [n.row.event.id, shape(n.children)] : n.row.event.id,
  );

describe("buildReplyTree", () => {
  it("nests each reply under the one it answers, oldest first by default", () => {
    const rows = [
      row("b", 2, "root"),
      row("a", 1, "root"),
      row("a1", 3, "a"),
      row("a1x", 4, "a1"),
    ];
    assert.deepEqual(
      shape(buildReplyTree(rows, { id: "root", isRoot: true })),
      [["a", [["a1", ["a1x"]]]], "b"],
    );
  });

  it("puts the best-scored sibling first", () => {
    const rows = [row("a", 1, "root"), row("b", 2, "root")];
    const score = { a: 0, b: 5 };
    assert.deepEqual(
      shape(
        buildReplyTree(rows, { id: "root", isRoot: true }, (id) => score[id]),
      ),
      ["b", "a"],
    );
  });

  it("puts a reply to a missing parent under the opened root, but not under a deeper reply", () => {
    const rows = [row("lost", 5, "gone")];
    assert.deepEqual(
      shape(buildReplyTree(rows, { id: "root", isRoot: true })),
      ["lost"],
    );
    assert.deepEqual(buildReplyTree(rows, { id: "mid", isRoot: false }), []);
  });

  it("shows only what sits under a deeper opened reply", () => {
    const rows = [
      row("a", 1, "root"),
      row("mid", 2, "a"),
      row("under", 3, "mid"),
      row("other", 4, "a"),
    ];
    assert.deepEqual(
      shape(buildReplyTree(rows, { id: "mid", isRoot: false })),
      ["under"],
    );
  });

  it("counts every reply at every depth", () => {
    const rows = [row("a", 1, "root"), row("a1", 2, "a"), row("b", 3, "root")];
    assert.equal(
      countReplies(buildReplyTree(rows, { id: "root", isRoot: true })),
      3,
    );
  });
});
