import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The words of the solo path stay plain and stay about one person. The first-week card, the "What did you get done?"
 * box, the founder's task buttons and the live line are read by someone alone with no connections: they never say
 * Shares, a price, returns, reviewers, a wallet, an address or a hash, never "earn", and never "the team" where "you"
 * is meant. Buttons name the result ("Add what you did", "I did it"), never "Set up more" or "Next steps".
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/** Visible words only: comments and imports are not what a person reads. */
function visible(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?;\n/gm, "");
}

const SOLO_FILES = [
  "./FirstWeekSteps.tsx",
  "./SoloWinDialog.tsx",
  "./TaskSoloActions.tsx",
  "./RecoveryKeyPrompt.tsx",
  "./StartedCard.tsx",
  "../lib/first-week.ts",
];

test("nothing on the solo path says Shares, a price, returns, reviewers, a wallet, an address, a hash or earn", () => {
  for (const file of SOLO_FILES) {
    const words = visible(source(file));
    for (const banned of [
      /\bShares?\b/,
      /\bprice\b/i,
      /\breturns\b|\breturn on\b|\bROI\b/i,
      /\breviewers?\b/i,
      /\bwallet\b/i,
      /\baddress(es)?\b/i,
      /\bhash(es)?\b/i,
      /\bearn(s|ed|ing)?\b/i,
    ])
      assert.doesNotMatch(words, banned, `${file} says ${banned}`);
  }
});

test("the card and the box speak to one person: no 'the team', no noun buttons", () => {
  for (const file of [
    "./FirstWeekSteps.tsx",
    "./SoloWinDialog.tsx",
    "../lib/first-week.ts",
  ]) {
    const words = visible(source(file));
    assert.doesNotMatch(words, /the team/i, `${file} says "the team"`);
    assert.doesNotMatch(words, /Set up more|Next steps/, file);
  }
});

test("the page and its cards never bring back 'Set up more', 'working alone' or 'by the helper' for a founder", () => {
  for (const file of [
    "./LaunchDetailPage.tsx",
    "./ProjectSetUp.tsx",
    "./ProjectTasksCard.tsx",
    "./TaskRow.tsx",
    "./TaskSoloActions.tsx",
    "./FirstWeekSteps.tsx",
  ]) {
    const words = visible(source(file));
    assert.doesNotMatch(words, /Set up more/, file);
    assert.doesNotMatch(words, /working alone/i, file);
    assert.doesNotMatch(words, /by the helper/i, file);
  }
});

test("the founder's own check is worded 'checked by you' to the founder, and never 'accepted'", () => {
  const dialog = visible(source("./SoloWinDialog.tsx"));
  assert.match(dialog, /Checked by you\./);
  assert.doesNotMatch(dialog, /accepted/i);
  assert.doesNotMatch(visible(source("./TaskSoloActions.tsx")), /accepted/i);
});
