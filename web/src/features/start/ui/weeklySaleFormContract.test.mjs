import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The Start form is the seam for which launch a kit takes: the sale fields show, and the weekly call is sent, only when the
 * network's kit reads as the weekly-sale kit. The components' source is read, as in the other contract tests; the rules are
 * tested on their own in `weekly-sale.test.mjs` and `contributor-flow-weekly.test.mjs`.
 */
const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("a project that opens with backing is held to the pool kit's limits in the form", () => {
  const page = source("./ContributorStartPage.tsx");
  assert.match(
    page,
    /const poolIssue = weekly\?\.pool \? poolKitIssue\(draft\) : null;/,
  );
  assert.match(
    page,
    /\(poolIssue \? \{ \.\.\.poolIssue, index: null, part: null \} : null\)/,
  );
});

test("the sale fields are in the form only for a weekly-sale kit, and their problem is part of the form's", () => {
  const page = source("./ContributorStartPage.tsx");
  assert.match(page, /const weekly = start\.network\?\.weekly \?\? null;/);
  assert.match(page, /\{weekly \? \(\s*<WeeklySaleFields/);
  assert.match(
    page,
    /weekly\s*\?\s*weeklySaleIssue\(draft, preview\?\.founderWhole\)/,
  );
});

test("the job carries the price token only when the kit is the weekly-sale kit, so a plain kit is launched as before", () => {
  const hook = source("../use-contributor-start.ts");
  assert.match(
    hook,
    /\.\.\.\(weekly\s*\?\s*\{\s*weekly: \{\s*quote: weekly\.quote,\s*\.\.\.\(weekly\.pool \? \{ pool: true as const \} : \{\}\),/,
  );
  // With investing on the pool kit makes the project; with it off the kit is the one the build always named.
  assert.match(
    hook,
    /\(investingOffered\(\) \? contributorKitV3\(chainId\) : null\) \?\?\s*contributorKit\(chainId\)/,
  );
  // The kit's version is read from the kit, not guessed from the build's settings.
  assert.match(hook, /readKitSale\(/);
  // The node is asked live, with a bound, before a weekly launch.
  assert.match(
    hook,
    /estimateGas: \(from, to, data\) =>\s*ethEstimateGas\(endpoint, \{ from, to, data \}\)/,
  );
});

test("the form's words show no protocol term and no setting name", () => {
  const fields = source("./WeeklySaleFields.tsx");
  const words = [...fields.matchAll(/(?:label|hint)="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(words.length >= 3);
  for (const text of words)
    assert.doesNotMatch(text, /VITE_|ERC|nsec|relay|gas|wei/i, text);
});
