import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The project page's legal line is never hidden or reworded: "Buyers acquire ownership only...", said beside the bid
 * button on a raise. The page was reworked around the first-week card and a shorter header, so this pins both halves of
 * it: the exact words, and that the page still hands them to the header on every project that is not a
 * contributor-only one. The source is the seam, as in `contributorOnlyGatesContract.test.mjs`: the mocked browser
 * suite does not seed a sale.
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

test("the ownership line says exactly what it said", () => {
  assert.match(
    flat(source("./widgets.tsx")),
    /Buyers acquire ownership only: governance and exit\. No dividends or revenue share, ever, unless they contribute and earn one\./,
  );
});

test("the page still passes the ownership line to the header, and the header still shows it", () => {
  const page = flat(source("./LaunchDetailPage.tsx"));
  assert.match(
    page,
    /note=\{ contributor \? null : \( [^)]*<OwnershipOnlyNote className="[^"]*" \/> \) \}/,
  );
  assert.match(flat(source("./LaunchHero.tsx")), /\{note\}/);
});
