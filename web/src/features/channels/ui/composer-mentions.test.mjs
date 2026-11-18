import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { composerKey, mentionedPubkeys } from "./composer-mentions.ts";

const ALICE = "a".repeat(64);
const AL = "b".repeat(64);
const SAM1 = "c".repeat(64);
const SAM2 = "d".repeat(64);

test("a chosen mention still in the words is tagged", () => {
  assert.deepEqual(
    mentionedPubkeys("hi @Alice see this", [{ pubkey: ALICE, name: "Alice" }]),
    [ALICE],
  );
});

test("a chosen mention deleted from the words tags nobody (no ghost ping)", () => {
  assert.deepEqual(
    mentionedPubkeys("hi see this", [{ pubkey: ALICE, name: "Alice" }]),
    [],
  );
  // Half-deleted label is not the label.
  assert.deepEqual(
    mentionedPubkeys("hi @Ali see this", [{ pubkey: ALICE, name: "Alice" }]),
    [],
  );
});

test("labels match whole: @Al is not inside @Alice, and the longest label owns an occurrence", () => {
  const picked = [
    { pubkey: AL, name: "Al" },
    { pubkey: ALICE, name: "Alice" },
  ];
  assert.deepEqual(mentionedPubkeys("thanks @Alice", picked), [ALICE]);
  assert.deepEqual(
    mentionedPubkeys("@Al Smith said", [
      { pubkey: AL, name: "Al" },
      { pubkey: ALICE, name: "Al Smith" },
    ]),
    [ALICE],
  );
  assert.deepEqual(mentionedPubkeys("@Al, @Alice!", picked), [AL, ALICE]);
  // Not a mention when glued to a word before it.
  assert.deepEqual(mentionedPubkeys("mail@Alice", picked), []);
});

test("same label chosen twice: each occurrence left keeps one choice, newest first", () => {
  const picked = [
    { pubkey: SAM1, name: "Sam" },
    { pubkey: SAM2, name: "Sam" },
  ];
  assert.deepEqual(mentionedPubkeys("@Sam and @Sam", picked), [SAM1, SAM2]);
  assert.deepEqual(mentionedPubkeys("only @Sam", picked), [SAM2]);
});

test("Enter with suggestions open picks the highlighted one, never sends", () => {
  const base = { shiftKey: false, isComposing: false, suggestions: 3 };
  assert.deepEqual(composerKey({ ...base, key: "Enter", active: 1 }), {
    type: "pick",
    index: 1,
  });
  assert.deepEqual(composerKey({ ...base, key: "Tab", active: 0 }), {
    type: "pick",
    index: 0,
  });
  assert.deepEqual(composerKey({ ...base, key: "ArrowDown", active: 2 }), {
    type: "move",
    index: 0,
  });
  assert.deepEqual(composerKey({ ...base, key: "ArrowUp", active: 0 }), {
    type: "move",
    index: 2,
  });
  assert.deepEqual(composerKey({ ...base, key: "Escape", active: 0 }), {
    type: "close",
  });
  // Shift+Enter and Shift+Tab keep their own meaning.
  assert.equal(
    composerKey({ ...base, key: "Enter", shiftKey: true, active: 0 }),
    null,
  );
  assert.equal(
    composerKey({ ...base, key: "Tab", shiftKey: true, active: 0 }),
    null,
  );
});

test("Enter with no suggestions sends; Shift+Enter is a new line; an input method's Enter is its own", () => {
  const base = { suggestions: 0, active: 0, isComposing: false };
  assert.deepEqual(composerKey({ ...base, key: "Enter", shiftKey: false }), {
    type: "send",
  });
  assert.equal(composerKey({ ...base, key: "Enter", shiftKey: true }), null);
  assert.equal(
    composerKey({
      ...base,
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      suggestions: 2,
    }),
    null,
  );
  assert.equal(
    composerKey({ ...base, key: "Enter", shiftKey: false, isComposing: true }),
    null,
  );
  // Safari: the Enter that confirms a conversion arrives with isComposing false and keyCode 229.
  assert.equal(
    composerKey({ ...base, key: "Enter", shiftKey: false, keyCode: 229 }),
    null,
  );
  assert.equal(
    composerKey({
      ...base,
      key: "Enter",
      shiftKey: false,
      keyCode: 229,
      suggestions: 2,
    }),
    null,
  );
  assert.deepEqual(
    composerKey({ ...base, key: "Enter", shiftKey: false, keyCode: 13 }),
    { type: "send" },
  );
});

test("the room composer sends through these helpers and says what to do when the server refuses", () => {
  const source = readFileSync(
    new URL("./Composer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /mentionedPubkeys\(content, mentionPicks\.current\)/);
  assert.match(source, /composerKey\(\{/);
  assert.match(source, /keyCode: e\.nativeEvent\.keyCode/);
  // The highlighted suggestion is named to screen readers while focus stays in the box.
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /id=\{mentionOptionId\(mentionListId, i\)\}/);
  assert.doesNotMatch(source, /rejected the event/);
  assert.match(source, /Your words are still in the box/);
  // The caret is put behind a chosen mention in the commit that writes it, not a frame later.
  assert.match(source, /pendingCaret\.current = before\.length/);
  assert.doesNotMatch(source, /requestAnimationFrame/);
  // The old send-on-any-Enter handler is gone.
  assert.doesNotMatch(source, /e\.key === "Enter" && !e\.shiftKey/);
});
