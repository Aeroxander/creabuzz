import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { applyEdit, commitLocalEdit, diffEdit } from "./text-edit.ts";

/**
 * Two peers, one shared document, one local editor value.
 *
 * Models the production shape: peer B's update is applied to the shared Y.Text
 * behind peer A's editor, then A's next keystroke arrives as a whole-document
 * string. The old implementation deleted the entire text and re-inserted that
 * string, so B's concurrent edit disappeared.
 */
function converged(seed, remoteEdit, localRendered, localValue) {
  const local = new Y.Doc();
  const text = local.getText("content");
  text.insert(0, seed);

  const remote = new Y.Doc();
  const remoteText = remote.getText("content");
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remoteEdit(remoteText);
  Y.applyUpdate(
    local,
    Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)),
  );

  const result = commitLocalEdit(text, localRendered, localValue);
  return { text: text.toString(), result };
}

const SEED = "intro\n\npara2\n";

test("a peer's appended edit survives a local edit at the start", () => {
  const { text, result } = converged(
    SEED,
    (t) => t.insert(t.length, "peer-tail"),
    SEED,
    `lead ${SEED}`,
  );
  assert.equal(result, "applied");
  assert.equal(text, `lead ${SEED}peer-tail`);
});

test("a peer's appended edit survives a local deletion elsewhere", () => {
  const { text, result } = converged(
    SEED,
    (t) => t.insert(t.length, "peer-tail"),
    SEED,
    "intro\n\n\n",
  );
  assert.equal(result, "applied");
  assert.equal(text, "intro\n\n\npeer-tail");
});

test("a peer's edit survives a local replacement in a different region", () => {
  const { text } = converged(
    SEED,
    (t) => t.insert(t.length, "peer-tail"),
    SEED,
    "INTRO\n\npara2\n",
  );
  assert.equal(text, "INTRO\n\npara2\npeer-tail");
});

test("an unresolvable overlap is reported instead of silently applying", () => {
  // Both peers rewrote the same characters: the deleted range no longer matches
  // what the editor saw, so the splice is refused and the draft is kept.
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "hello");
  text.delete(0, 5);
  text.insert(0, "HELLO");

  const result = commitLocalEdit(text, "hello", "helo");
  assert.equal(result, "replaced");
  assert.equal(text.toString(), "helo");
});

test("a stale baseline cannot reach into text the document no longer has", () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "short");
  // Baseline claims a much longer document (peer deleted it).
  assert.doesNotThrow(() =>
    commitLocalEdit(text, "a".repeat(500), "b".repeat(500)),
  );
});

test("no drift applies the delta verbatim", () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "hello world");
  const result = commitLocalEdit(text, "hello world", "hello brave world");
  assert.equal(result, "applied");
  assert.equal(text.toString(), "hello brave world");
});

test("an unchanged value is a no-op", () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "same");
  assert.equal(commitLocalEdit(text, "same", "same"), "noop");
  assert.equal(text.toString(), "same");
});

test("diffEdit reports the smallest replacement", () => {
  assert.deepEqual(diffEdit("abc", "abc"), null);
  assert.deepEqual(diffEdit("abc", "axc"), {
    index: 1,
    deleteCount: 1,
    insert: "x",
  });
  assert.deepEqual(diffEdit("abc", "abcdef"), {
    index: 3,
    deleteCount: 0,
    insert: "def",
  });
  assert.deepEqual(diffEdit("abcdef", "abc"), {
    index: 3,
    deleteCount: 3,
    insert: "",
  });
  assert.deepEqual(diffEdit("", "new"), {
    index: 0,
    deleteCount: 0,
    insert: "new",
  });
});

test("applyEdit clamps a stale index instead of throwing", () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "ab");
  applyEdit(text, { index: 99, deleteCount: 5, insert: "!" });
  assert.equal(text.toString(), "ab!");
});
