import assert from "node:assert/strict";
import test from "node:test";

import { insertTextIntoComposer } from "./composerTextInsert.ts";

function fakeComposerRoot({ editor }) {
  return {
    querySelector(selector) {
      assert.equal(selector, '[data-testid="message-input"]');
      return editor;
    },
  };
}

function fakeEditor() {
  const calls = { focused: 0 };
  return {
    calls,
    focus() {
      calls.focused += 1;
    },
  };
}

test("inserts text through the DOM-native editing path after focusing", () => {
  const editor = fakeEditor();
  const execCalls = [];
  globalThis.document = {
    execCommand(command, showUi, value) {
      execCalls.push([command, showUi, value]);
      return true;
    },
  };

  const inserted = insertTextIntoComposer(fakeComposerRoot({ editor }), "@");

  assert.equal(inserted, true);
  assert.equal(editor.calls.focused, 1);
  assert.deepEqual(execCalls, [["insertText", false, "@"]]);
  delete globalThis.document;
});

test("still focuses the composer when insertion is unavailable", () => {
  const editor = fakeEditor();
  globalThis.document = {
    execCommand() {
      throw new Error("execCommand unsupported");
    },
  };

  const inserted = insertTextIntoComposer(fakeComposerRoot({ editor }), "@");

  assert.equal(inserted, false);
  assert.equal(editor.calls.focused, 1);
  delete globalThis.document;
});

test("returns false without a composer editor", () => {
  globalThis.document = {
    execCommand() {
      throw new Error("must not be called");
    },
  };

  assert.equal(insertTextIntoComposer(null, "@"), false);
  assert.equal(
    insertTextIntoComposer(fakeComposerRoot({ editor: null }), "@"),
    false,
  );
  delete globalThis.document;
});
