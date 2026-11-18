import assert from "node:assert/strict";
import test from "node:test";
import { commentThreads } from "./comment-threads.ts";

const comment = (id, createdAt, replyTo = null) => ({
  id,
  createdAt,
  replyTo,
  author: "ann",
  body: id,
  score: 0,
  myVote: 0,
  myVoteIds: [],
});
const shape = (nodes) =>
  nodes.map(({ comment, children }) => [comment.id, shape(children)]);

test("answers stay under their parent instead of following a newer top-level comment", () => {
  const comments = [
    comment("second", 20),
    comment("child", 30, "first"),
    comment("grandchild", 40, "child"),
    comment("first", 10),
  ];
  assert.deepEqual(shape(commentThreads(comments)), [
    ["first", [["child", [["grandchild", []]]]]],
    ["second", []],
  ]);
  assert.deepEqual(
    comments.map((c) => c.id),
    ["second", "child", "grandchild", "first"],
  );
});

test("missing parents remain visible and can collect their own replies", () => {
  assert.deepEqual(
    shape(
      commentThreads([
        comment("orphan", 10, "missing"),
        comment("child", 11, "orphan"),
      ]),
    ),
    [["orphan", [["child", []]]]],
  );
});

test("malformed self references and cycles cannot hide replies or loop forever", () => {
  assert.deepEqual(
    shape(
      commentThreads([
        comment("self", 1, "self"),
        comment("a", 2, "b"),
        comment("b", 3, "a"),
        comment("c", 4, "b"),
      ]),
    ),
    [
      ["self", []],
      ["a", [["b", [["c", []]]]]],
    ],
  );
});

test("the board's full comment read can be a single deep branch", () => {
  const comments = Array.from({ length: 1000 }, (_, i) =>
    comment(String(i), i, i ? String(i - 1) : null),
  );
  let nodes = commentThreads(comments.reverse());
  for (let i = 0; i < 1000; i++) {
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].comment.id, String(i));
    nodes = nodes[0].children;
  }
  assert.deepEqual(nodes, []);
});
