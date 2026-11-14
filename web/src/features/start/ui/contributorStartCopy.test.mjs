import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as copy from "../lib/contributor-start-copy.ts";

/**
 * Plain words ask for a word to be explained once per screen. On the contributor Start page that word is Shares: the
 * header defines it as votes in the project, and nothing else on the page (the card, the board note, the form, the
 * weekly sale) says so again, in any wording. The words are read from the copy module the page renders from, for the
 * build that offers raises and the one that does not; the source files are scanned too, for wording that bypasses it.
 */
const dir = (name) => fileURLToPath(new URL(name, import.meta.url));

// Any way of saying what a Share is: "which are votes", "Shares are votes", "the project's voting tokens".
const DEFINES_SHARES =
  /\b(?:which are|are|is|as|the project'?s)\s+(?:a\s+)?(?:votes?|voting tokens)\b|voting tokens/i;

/** Everything the page says besides the header, whichever build: the card, the hints, the success text, the sale intro. */
const BELOW_HEADER = [
  ...copy.WHAT_IT_IS_POINTS,
  copy.PITCH_HINT,
  copy.QUORUM_HINT,
  copy.REVIEWERS_HINT,
  copy.WORK_AREAS_HINT,
  copy.DONE_TEXT,
  copy.SALE_INTRO,
  copy.SALE_CLIFF_HINT,
  copy.SALE_DAYS_HINT,
  copy.whatItIsTitle(true),
  copy.whatItIsTitle(false),
];

test("the matcher catches every wording of the definition", () => {
  for (const repeat of [
    "Shares, which are votes in the project",
    "Shares are votes in the project",
    "Shares, the project's voting tokens",
    "Each Share is a vote",
    "your voting tokens",
  ])
    assert.match(repeat, DEFINES_SHARES, repeat);
  // Saying that the project votes is not saying what a Share is.
  for (const fine of [
    "then the project votes on an award",
    "Selling opens only after two project votes",
    "so you can open and back the first votes",
  ])
    assert.doesNotMatch(fine, DEFINES_SHARES, fine);
});

test("both builds define Shares once, in the header, with the same words", () => {
  for (const raises of [true, false]) {
    const header = copy.startHeaderDescription(raises);
    assert.match(header, /Shares, which are votes in the project\.$/, header);
    assert.equal(header.match(DEFINES_SHARES) ? 1 : 0, 1);
    assert.doesNotMatch(header, /voting tokens/);
  }
  for (const text of BELOW_HEADER) assert.doesNotMatch(text, DEFINES_SHARES);
});

test("no source file of the contributor Start page defines Shares a second time", () => {
  const ui = dir("./");
  const lib = dir("../lib/");
  const files = [
    ...readdirSync(ui).map((name) => [ui, name]),
    ...readdirSync(lib).map((name) => [lib, name]),
  ]
    .filter(([, name]) => /\.(tsx?|mjs)$/.test(name) && !/\.test\./.test(name))
    // The chooser between ways to start is its own screen, with its own sentence about Shares.
    .filter(([, name]) => name !== "StartPage.tsx")
    .map(([where, name]) => [name, readFileSync(`${where}${name}`, "utf8")]);
  // The page's components and the libraries behind it are all in the scan.
  for (const name of [
    "ContributorStartPage.tsx",
    "FirstProjectsField.tsx",
    "ReviewersPicked.tsx",
    "RemixFields.tsx",
    "WeeklySaleFields.tsx",
    "contributor-project.ts",
    "contributor-flow.ts",
    "from-pitch.ts",
    "weekly-sale.ts",
    "contributor-start-copy.ts",
  ])
    assert.ok(
      files.some(([found]) => found === name),
      `${name} is scanned`,
    );
  const defining = files.flatMap(([name, text]) =>
    // Comments explain the rule; only strings and JSX text reach a reader.
    text
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter((line) => DEFINES_SHARES.test(line))
      .map((line) => `${name}: ${line.trim()}`),
  );
  assert.equal(defining.length, 1, defining.join("\n"));
  assert.match(defining[0], /^contributor-start-copy\.ts: .*which are votes/);
});

test("the card still states the rules a founder must know before signing", () => {
  const card = copy.WHAT_IT_IS_POINTS.join("\n");
  assert.match(card, /Shares can't be sold at first/);
  assert.match(card, /Approval alone gives no Shares\./);
  assert.match(card, /two project votes, at least 30 days apart/);
  assert.match(card, /can still receive money into its funds\./);
  assert.match(card, /reviewers you name check it/);
  assert.match(card, /the project votes on an award/);
});

test("each hint reads alone and keeps the rule it carries", () => {
  assert.match(copy.QUORUM_HINT, /At least two must agree\./);
  assert.match(copy.PITCH_HINT, /about the project/);
  // What a reviewer does is the card's to say; the hint only says who to pick.
  assert.doesNotMatch(copy.REVIEWERS_HINT, /check/);
  assert.match(copy.WORK_AREAS_HINT, /You accept each submission/);
  // The form is gone once the project exists: the success text keeps the founder's step and the next action.
  assert.match(copy.DONE_TEXT, /You accept each submission/);
  assert.match(copy.DONE_TEXT, /reviewers you named check it/);
  assert.match(copy.DONE_TEXT, /Share the Work page/);
  // A hint that points at "the wait above" cannot be read alone.
  assert.doesNotMatch(copy.SALE_DAYS_HINT, /\babove\b|\bbelow\b/);
  assert.match(copy.SALE_DAYS_HINT, /wait before your first sale/);
});

test("selling is one word, and unlocking is said once on the page, in the field it names", () => {
  const page = [...copy.WHAT_IT_IS_POINTS, copy.SALE_INTRO].join("\n");
  assert.doesNotMatch(page, /transfer|market/i);
  assert.match(copy.SALE_INTRO, /once selling is open/);
  assert.match(copy.WHAT_IT_IS_POINTS[2], /Selling opens/);
  for (const text of [...BELOW_HEADER]) assert.doesNotMatch(text, /unlock/i);
  // The free test token is explained in the sale intro alone.
  const mentions = BELOW_HEADER.filter((text) => /worth nothing/.test(text));
  assert.deepEqual(mentions, [copy.SALE_INTRO]);
});

test("the page renders from the copy module, not from lines of its own", () => {
  const page = readFileSync(dir("./ContributorStartPage.tsx"), "utf8");
  assert.match(page, /startHeaderDescription\(raises\)/);
  assert.match(page, /WHAT_IT_IS_POINTS\.map/);
  assert.match(page, /whatItIsTitle\(raises\)/);
  assert.match(page, /hint=\{PITCH_HINT\}/);
  assert.match(page, /hint=\{QUORUM_HINT\}/);
  assert.match(page, /hint=\{REVIEWERS_HINT\}/);
  assert.match(page, /\{DONE_TEXT\}/);
  assert.match(
    readFileSync(dir("./FirstProjectsField.tsx"), "utf8"),
    /\{WORK_AREAS_HINT\}/,
  );
  const sale = readFileSync(dir("./WeeklySaleFields.tsx"), "utf8");
  assert.match(sale, /\{SALE_INTRO\}/);
  assert.match(sale, /hint=\{SALE_CLIFF_HINT\}/);
  assert.match(sale, /hint=\{SALE_DAYS_HINT\}/);
});
