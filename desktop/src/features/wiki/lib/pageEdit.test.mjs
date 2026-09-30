import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_WIKI_PAGE,
  applyTextEdit,
  buildPageSavePayload,
  diffEdit,
} from "./pageEdit.ts";

test("diffEdit finds the minimal replacement", () => {
  assert.deepEqual(diffEdit("hello", "hello"), null);
  assert.deepEqual(diffEdit("hello", "hallo"), {
    index: 1,
    deleteCount: 1,
    insert: "a",
  });
  assert.deepEqual(diffEdit("abc", "abcde"), {
    index: 3,
    deleteCount: 0,
    insert: "de",
  });
  assert.deepEqual(diffEdit("abcde", "abc"), {
    index: 3,
    deleteCount: 2,
    insert: "",
  });
  assert.deepEqual(diffEdit("same", "different"), {
    index: 0,
    deleteCount: 4,
    insert: "different",
  });
});

test("applyTextEdit splices the edit and clamps an out-of-range", () => {
  assert.equal(
    applyTextEdit("hello", { index: 1, deleteCount: 1, insert: "a" }),
    "hallo",
  );
  assert.equal(
    applyTextEdit("hello", { index: 3, deleteCount: 0, insert: "p" }),
    "helplo",
  );
  // A delete that overruns the tail is clamped, not corrupted.
  assert.equal(
    applyTextEdit("abc", { index: 1, deleteCount: 99, insert: "X" }),
    "aX",
  );
  // An index past the end appends rather than throwing.
  assert.equal(
    applyTextEdit("abc", { index: 99, deleteCount: 0, insert: "!" }),
    "abc!",
  );
});

test("diffEdit + applyTextEdit round-trips before → after", () => {
  const cases = [
    ["", "fresh"],
    ["full page", "full page, revised"],
    ["delete the middle out", "delete out"],
    ["line one\nline two", "line one\nline 2\nline three"],
  ];
  for (const [before, after] of cases) {
    const edit = diffEdit(before, after);
    const result = edit ? applyTextEdit(before, edit) : before;
    assert.equal(result, after);
  }
});

test("buildPageSavePayload matches the web save event shape", () => {
  const payload = buildPageSavePayload({
    slug: "home",
    content: "body",
    now: 1234,
  });
  assert.equal(payload.kind, KIND_WIKI_PAGE);
  assert.deepEqual(payload.tags, [["d", "home"]]);
  assert.equal(payload.content, "body");
  assert.equal(payload.created_at, 1234);
});

test("buildPageSavePayload preserves the team scope tag", () => {
  const payload = buildPageSavePayload({
    slug: "home",
    content: "body",
    now: 1,
    scope: "design",
  });
  assert.deepEqual(payload.tags, [
    ["d", "home"],
    ["t", "team:design"],
  ]);
  // No scope → no scope tag.
  const open = buildPageSavePayload({ slug: "home", content: "b", now: 1 });
  assert.deepEqual(open.tags, [["d", "home"]]);
});
