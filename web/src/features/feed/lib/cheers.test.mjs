import assert from "node:assert/strict";
import { test } from "node:test";

import { cheerCountWords, cheerers, cheerTarget } from "./cheers.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const base = { at: 1, coordinate: "c" };
const update = (kept) => ({
  ...base,
  kind: "update",
  id: "u1",
  author: A,
  answers: { kept, missed: 1, changed: 0 },
});

test("only a kept promise and accepted work can be cheered", () => {
  assert.deepEqual(cheerTarget(update(2)), {
    id: "u1",
    pubkey: A,
    kind: 47003,
  });
  assert.equal(cheerTarget(update(0)), null);
  assert.equal(
    cheerTarget({
      ...base,
      kind: "goal",
      id: "g",
      author: A,
      state: "reached",
    }),
    null,
  );
  // Accepted work: the cheer names the task and goes to whoever did it.
  assert.deepEqual(
    cheerTarget({
      ...base,
      kind: "work",
      id: "work:t1",
      taskId: "t1",
      author: A,
      helper: B,
    }),
    { id: "t1", pubkey: B, kind: 47003 },
  );
});

test("one cheer per account, however many it sent; down votes and other records are not cheers", () => {
  const r = (pubkey, target, content = "+", kind = 7) => ({
    kind,
    pubkey,
    content,
    tags: [["e", target]],
  });
  const got = cheerers(
    [
      r(A, "u1"),
      r(A, "u1"),
      r(B, "u1"),
      r(B, "u1", "-"),
      r(A, "other"),
      r(A, "u1", "+", 1),
    ],
    ["u1", "t1"],
  );
  assert.deepEqual([...(got.get("u1") ?? [])].sort(), [A, B]);
  assert.equal(got.has("other"), false);
  assert.equal(got.has("t1"), false);
});

test("the count reads as words", () => {
  assert.equal(cheerCountWords(0), "No cheers yet");
  assert.equal(cheerCountWords(1), "1 cheer");
  assert.equal(cheerCountWords(3), "3 cheers");
});
