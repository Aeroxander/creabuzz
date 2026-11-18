import assert from "node:assert/strict";
import test from "node:test";

import { lintDoneMeans } from "./done-means-lint.ts";

const kinds = (text) => lintDoneMeans(text).map((w) => w.kind);

test("empty words get no warning here: leaving them empty is refused elsewhere", () => {
  assert.deepEqual(lintDoneMeans(""), []);
  assert.deepEqual(lintDoneMeans("   \n "), []);
});

test("words with a number, a link, a file name or a named deliverable have something to check", () => {
  for (const text of [
    "The pass rate is at least 80% on the held-out set.",
    "Published at https://example.org/chart and linked from the home page.",
    "A file called atlas.png in the repo.",
    'The page called "Northern sky" is live.',
    "A screen recording of sign-up working on Android 9.",
    "A pull request that is merged.",
    "A report",
  ])
    assert.deepEqual(kinds(text), [], text);
});

test("words with nothing to count or open are warned about, and the warning says what to add", () => {
  for (const text of [
    "Make it work",
    "It is finished and everyone is happy",
    "Done when the team agrees",
  ]) {
    const warnings = lintDoneMeans(text);
    assert.deepEqual(
      warnings.map((w) => w.kind),
      ["measure"],
      text,
    );
    assert.match(
      warnings[0].message,
      /number, a link, or the name of what will exist/,
    );
  }
});

test("vague words are named, each once, and a plural does not hide one", () => {
  const warnings = lintDoneMeans(
    "Make the sign-up better and better, and clean up some things.",
  );
  const vague = warnings.find((w) => w.kind === "vague");
  assert.deepEqual(vague.words, ["better", "clean", "some", "things"]);
  assert.match(vague.message, /"better", "clean", "some", "things"/);
  // A word inside another word is not the word.
  assert.deepEqual(
    kinds("Wellington office: 3 photos, a nicely named folder"),
    [],
  );
  assert.deepEqual(
    kinds("Ship 2 tests that pass; okay is not a word here, 0 stuffed toys"),
    ["vague"],
  );
});

test("a measurable sentence can still be warned about for a vague word, and the other way round", () => {
  assert.deepEqual(kinds("A good report"), ["vague"]);
  assert.deepEqual(kinds("A report with 3 charts, polished"), ["vague"]);
  assert.deepEqual(kinds("It works properly"), ["measure", "vague"]);
});

test("the usual loose words are all on the list", () => {
  for (const word of [
    "good",
    "well",
    "better",
    "properly",
    "enough",
    "etc",
    "as needed",
    "and so on",
  ])
    assert.deepEqual(
      lintDoneMeans(`A report that is ${word} 3`).find(
        (w) => w.kind === "vague",
      )?.words,
      [word],
      word,
    );
});

test("a lint never blocks: it returns warnings and nothing else", () => {
  for (const warning of lintDoneMeans("It works well")) {
    assert.ok(["measure", "vague"].includes(warning.kind));
    assert.equal(typeof warning.message, "string");
    assert.equal("block" in warning, false);
  }
});
