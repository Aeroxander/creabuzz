import assert from "node:assert/strict";
import { test } from "node:test";

import { idWord } from "@creaton/core/launchpad/work.ts";

import {
  knownTitles,
  readableName,
  readableQuotes,
  shortNameBeside,
  workTitle,
} from "./work-titles.ts";

test("a code-style short name reads as a title; anything typed as words stays as typed", () => {
  assert.equal(readableName("first-hour-notes"), "First hour notes");
  assert.equal(readableName("bug_report"), "Bug report");
  assert.equal(readableName("docs"), "Docs");
  assert.equal(readableName("Bug reports"), "Bug reports");
  assert.equal(readableName("v2-API"), "v2-API");
  assert.equal(readableName("0xabababab…abab"), "0xabababab…abab");
});

test("a published title wins over the short name, and the short name is shown beside a title only when it differs", () => {
  const area = { projectId: idWord("garden-guide"), checkHash: "0xaa" };
  const known = knownTitles(
    [{ ...area, title: "Plant guide for community gardens", createdAt: 10 }],
    [area],
  );
  assert.equal(
    workTitle(idWord("garden-guide"), known),
    "Plant guide for community gardens",
  );
  assert.equal(workTitle(idWord("plain-guide"), known), "Plain guide");
  assert.equal(workTitle(idWord("Bug reports")), "Bug reports");
  assert.equal(
    shortNameBeside(idWord("plain-guide"), "Plain guide"),
    "plain-guide",
  );
  assert.equal(shortNameBeside(idWord("Bug reports"), "Bug reports"), null);
  // A hash id has no short name worth showing.
  assert.equal(shortNameBeside(`0x${"ab".repeat(32)}`, "x"), null);
});

test("only the suggestion an approved area was made from names it: a newer one with the same short name cannot rename it", () => {
  const area = { projectId: idWord("docs"), checkHash: "0xaa" };
  const known = knownTitles(
    [
      // Newest first, as the board returns them.
      {
        projectId: idWord("docs"),
        checkHash: "0xbb",
        title: "Payroll, do not accept",
        createdAt: 30,
      },
      { ...area, title: "Copy of the docs words", createdAt: 20 },
      { ...area, title: "Guide for new members", createdAt: 10 },
      // Not approved at all.
      {
        projectId: idWord("search"),
        checkHash: "0xcc",
        title: "Fix search",
        createdAt: 5,
      },
    ],
    [area],
  );
  assert.equal(workTitle(idWord("docs"), known), "Guide for new members");
  assert.equal(workTitle(idWord("search"), known), "Search");
  // Matching is by id and words, not case.
  assert.equal(
    workTitle(
      idWord("docs"),
      knownTitles(
        [{ ...area, checkHash: "0xAA", title: "Docs guide", createdAt: 1 }],
        [area],
      ),
    ),
    "Docs guide",
  );
  // Nothing approved yet: no published title.
  assert.equal(
    workTitle(
      idWord("docs"),
      knownTitles([{ ...area, title: "Docs guide", createdAt: 1 }], []),
    ),
    "Docs",
  );
});

test("quoted short names in a decision's words are made readable; other quotes stay", () => {
  assert.equal(
    readableQuotes("Approve the work area “garden-guide”"),
    "Approve the work area “Garden guide”",
  );
  assert.equal(
    readableQuotes("Award 8,000 Shares for the submission “first-hour”"),
    "Award 8,000 Shares for the submission “First hour”",
  );
  assert.equal(
    readableQuotes("Finished looks like: “A guide, posted on the board.”"),
    "Finished looks like: “A guide, posted on the board.”",
  );
});
