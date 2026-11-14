import assert from "node:assert/strict";
import test from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";

import {
  openWorkAreas,
  recordSources,
  wordsAfterMove,
  wordsFor,
  wordsProblem,
  workAreaUpdateContent,
} from "./ways-to-help.ts";

const BUDGET = `0x${"b1".repeat(20)}`;
const OTHER = `0x${"b2".repeat(20)}`;
const MANAGER = `0x${"f0".repeat(20)}`;
const E18 = 10n ** 18n;
const DOCS = "the docs are merged and reviewed";

function area(name, check, over = {}) {
  return {
    id: idWord(name),
    record: {
      manager: MANAGER,
      budget: 0n,
      reserved: 0n,
      expiresAt: 5_000,
      checkHash: hashText(check),
      shareBudget: 40n * E18,
      sharesAwarded: 0n,
      ...over,
    },
  };
}

function work(projects, over = {}) {
  return {
    chainTime: 1_000,
    mandates: [
      {
        address: BUDGET,
        closed: false,
        isMilestonePanel: false,
        expiresAt: 9_000,
        projects,
        ...over,
      },
    ],
  };
}

test("words are shown only when they hash to the work area's check", () => {
  const target = {
    mandate: BUDGET,
    id: idWord("docs"),
    checkHash: hashText(DOCS),
  };
  assert.equal(wordsFor(target, [{ text: "something else" }]), null);
  assert.equal(wordsFor(target, [{ text: DOCS }]), DOCS);
  // Published with stray spaces around it: the words that were hashed are the ones shown.
  assert.equal(wordsFor(target, [{ text: `  ${DOCS} ` }]), DOCS);
  // A source for another budget or another work area is never used, even with the right words.
  assert.equal(wordsFor(target, [{ text: DOCS, mandate: OTHER }]), null);
  assert.equal(wordsFor(target, [{ text: DOCS, id: idWord("other") }]), null);
  assert.equal(
    wordsFor(target, [
      {
        text: DOCS,
        mandate: BUDGET.toUpperCase().replace("0X", "0x"),
        id: idWord("docs"),
      },
    ]),
    DOCS,
  );
});

test("a record's first work areas are sources by name", () => {
  const sources = recordSources([
    { name: "docs", check: DOCS },
    { name: "x".repeat(40), check: "too long a name for a work area" },
  ]);
  assert.deepEqual(sources, [{ text: DOCS, id: idWord("docs") }]);
});

test("open work areas: in an open budget, not past their end, with Shares or money left; each with its words", () => {
  const areas = openWorkAreas(
    work([
      area("docs", DOCS),
      area("examples", "every example runs", { expiresAt: 3_000 }),
      // Spent, ended, or with nothing to give: not open.
      area("spent", "x", { sharesAwarded: 40n * E18 }),
      area("ended", "x", { expiresAt: 900 }),
      area("money", "paid work", {
        shareBudget: 0n,
        budget: 100n,
        reserved: 40n,
      }),
    ]),
    recordSources([{ name: "docs", check: DOCS }]),
  );
  assert.deepEqual(
    areas.map((a) => [a.name, a.words, a.sharesLeft, a.moneyLeft]),
    [
      // Soonest to close first.
      ["examples", null, 40n * E18, 0n],
      ["docs", DOCS, 40n * E18, 0n],
      ["money", null, 0n, 60n],
    ],
  );
  // A closed budget, an ended one, and the milestone panel offer nothing.
  for (const over of [
    { closed: true },
    { expiresAt: 1_000 },
    { isMilestonePanel: true },
  ]) {
    assert.deepEqual(openWorkAreas(work([area("docs", DOCS)], over), []), []);
  }
});

test("the update that publishes a work area's words names the budget and the work area, as the parser reads it", () => {
  const content = workAreaUpdateContent({
    mandate: BUDGET.toUpperCase().replace("0X", "0x"),
    id: idWord("guide-es"),
    check: DOCS,
  });
  assert.deepEqual(content.workArea, {
    id: idWord("guide-es"),
    mandate: BUDGET,
    check: DOCS,
  });
  assert.equal(content.title, "Proposed work area: Guide es");
  assert.match(content.body, /^Being voted on\. Done when: /);
});

const formArea = (name, words, check = words ?? "approved words") => ({
  mandate: BUDGET,
  id: idWord(name),
  name,
  words,
  checkHash: hashText(check),
});

test("moving between work areas never carries one area's words into another", () => {
  const drafts = new Map();
  const a = formArea("docs", DOCS);
  const b = formArea("art", null, "the art is drawn and reviewed");
  // From A (its published words in the box) to B, whose words are not published: the box is empty, not A's words.
  assert.equal(wordsAfterMove(drafts, null, "", a), DOCS);
  assert.equal(wordsAfterMove(drafts, a, DOCS, b), "");
  // What was typed for B comes back when returning to it; A shows its own words again.
  assert.equal(wordsAfterMove(drafts, b, "the art is drawn", a), DOCS);
  assert.equal(wordsAfterMove(drafts, a, DOCS, b), "the art is drawn");
  // "Not sure yet" keeps the text as it is.
  assert.equal(wordsAfterMove(drafts, b, "typed", null), "typed");
});

test("the words must hash to the chosen work area's check, read again when submitting", () => {
  const b = formArea("art", null, "the art is drawn and reviewed");
  // A's words chosen for B: refused, with what to do.
  assert.match(
    wordsProblem(b, DOCS),
    /These are not art's words as it was approved/,
  );
  assert.equal(wordsProblem(b, "the art is drawn and reviewed"), null);
  // The criteria changed since the page opened: the area read now has other words, so the old ones are refused.
  const changed = formArea(
    "docs",
    "the docs are merged, reviewed and translated",
  );
  assert.match(wordsProblem(changed, DOCS), /These are not docs's exact words/);
  // No area chosen: nothing to check against.
  assert.equal(wordsProblem(null, "anything"), null);
});

test("an open work area reads by a published title, else its short name made readable, and keeps its short name", () => {
  const areas = openWorkAreas(
    work([area("garden-guide", DOCS), area("plain-guide", DOCS)]),
    [],
    new Map([["garden-guide", "Plant guide for community gardens"]]),
  );
  assert.deepEqual(
    areas.map((a) => [a.name, a.title]),
    [
      ["garden-guide", "Plant guide for community gardens"],
      ["plain-guide", "Plain guide"],
    ],
  );
});
