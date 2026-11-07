import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The contributor-only hosted build (`VITE_CONTRIBUTOR_ONLY=1`, `raisesOffered`) shows no step that starts a sale. The
 * mocked browser suite runs one ordinary build, so it cannot switch that setting per test: the components' source is the
 * seam here, as in `shared/ui/queryErrorContract.test.mjs`. `raises-offered.test.mjs` pins the setting itself.
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/** The text between `start` and the first `end` after it. */
function between(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return text.slice(from, to);
}

test("an idea's sale steps show only where the build offers raises", () => {
  const card = source("./IdeaProgressCard.tsx");
  assert.match(card, /const raises = raisesOffered\(\);/);
  // Everything that prepares a sale sits in the `raises ?` branch, before its `) : (`.
  const saleBranch = between(card, "{raises ? (", ") : (");
  for (const testId of ["idea-prepare-sale", "idea-prepare-anyway"]) {
    assert.equal(
      card.split(`"${testId}"`).length - 1,
      1,
      `${testId} appears once`,
    );
    assert.match(saleBranch, new RegExp(`"${testId}"`), `${testId} is gated`);
  }
  assert.match(card, /\{raises && preparing \? \(\s*<CreateLaunchDialog/);
  // Without raises the idea still leads somewhere: a contributor project.
  const otherwise = between(
    card.slice(card.indexOf("{raises ? (") + saleBranch.length),
    ") : (",
    ")}",
  );
  assert.match(otherwise, /data-testid="idea-start-contributor"/);
  assert.match(otherwise, /to="\/start\/contributor"/);
  assert.doesNotMatch(otherwise, /sale/i);
});

test("an idea promises a sale only where the build offers raises", () => {
  const overview = source("./IdeaOverview.tsx");
  assert.match(overview, /const raises = raisesOffered\(\);/);
  const promise = overview.indexOf("If the founder opens a sale");
  assert.notEqual(promise, -1);
  assert.match(overview.slice(0, promise), /\{raises\s*\?\s*"\s*$/);
});

test("the launchpad's sale buttons stay behind the same setting", () => {
  const page = source("./LaunchesPage.tsx");
  assert.match(page, /const raises = raisesOffered\(\);/);
  assert.match(
    page,
    /useState\(start === "sale" && raises\)/,
    "?start=sale opens nothing without raises",
  );
  assert.match(page, /\{createOpen && raises \? \(/);
});
