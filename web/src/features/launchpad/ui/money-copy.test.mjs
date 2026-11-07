import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Copy on the money screens (outside review A, phase 3): a dialog says what pressing it does for the person, not how the
 * contracts book it, and a failure says what to do next. The components are the seam (node cannot render the .tsx), so
 * the source is read with its comments taken out.
 */
const source = (name) =>
  readFileSync(new URL(name, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

test("the bid dialogs describe the person's action, not the ledger", () => {
  const panel = source("./MyBidsPanel.tsx");
  for (const narration of [
    /chain is the ledger/i,
    /nothing to mirror/i,
    /auction contract bid/i,
    /claim block/i,
    /unfilled share/i,
  ]) {
    assert.doesNotMatch(panel, narration);
  }
  assert.match(panel, /Takes back the part of your bid the sale didn't use/);
  // The dialog titles use the button's words, so one action has one name on the screen.
  assert.match(panel, /Take back unspent money from bid #/);
  assert.match(panel, /Collect tokens for bid #/);
});

test("a failed bid action says what to do next, not just that it failed", () => {
  const panel = source("./MyBidsPanel.tsx");
  assert.doesNotMatch(panel, /"The action was not sent\."/);
  assert.match(panel, /Nothing was sent\. Press the button again/);
});

test("the founder's longer story hint has no record or commit jargon", () => {
  const fields = source("./create-wizard/AdvancedFields.tsx");
  assert.doesNotMatch(fields, /record only goes live once this is committed/);
  assert.match(fields, /The launch can't go live without it\./);
});
