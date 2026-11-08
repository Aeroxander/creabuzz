import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Plain words ask for a word to be explained once per screen. On the contributor Start page that word is Shares: the
 * header defines it as votes in the project, and nothing below it (the card, the board note, the form) says so again.
 * The components' source is read, as in the other contract tests.
 */
const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the contributor Start page defines Shares as votes in the project once, in the header", () => {
  const files = [
    "./ContributorStartPage.tsx",
    "./FirstProjectsField.tsx",
    "./ReviewersPicked.tsx",
    "./WeeklySaleFields.tsx",
    "../lib/contributor-project.ts",
  ];
  const text = files.map(source).join("\n");
  assert.equal(text.match(/which are votes in the project/g)?.length, 1);
  assert.match(
    source("./ContributorStartPage.tsx"),
    /reviewed work earns Shares, which are votes in the project\./,
  );
});
