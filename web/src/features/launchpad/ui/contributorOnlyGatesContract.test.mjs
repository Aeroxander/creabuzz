import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The contributor-only hosted build (`VITE_CONTRIBUTOR_ONLY=1`, `raisesOffered`) offers no sale anywhere. The mocked
 * browser suite runs one ordinary build and cannot switch that setting per test, so, as in
 * `ideaSaleStepsContract.test.mjs`, the components' source is the seam for the gates that live in components. The rules
 * themselves are pure and tested on their own: `contributor-only.test.mjs` (what is listed, the funding line),
 * `directory.test.mjs` (Discover), `start-steps.test.mjs`, `portfolio-label.test.mjs`, `sale-action.test.mjs`. The
 * screen audit's hosted capture checks the built pages (`tests/e2e-real/screen-audit.spec.ts`).
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the decision form never offers to open trading without raises", () => {
  const composer = source("./DecisionComposer.tsx");
  assert.match(
    composer,
    /if \(id === "trading" && !raisesOffered\(\)\) return false;/,
  );
});

test("the weekly-market listing vote follows the trading switch, not raises", () => {
  const composer = source("./DecisionComposer.tsx");
  const start = composer.indexOf('if (id === "secondary-listing")');
  assert.ok(start >= 0, "the listing entry is found");
  const entry = composer.slice(
    start,
    composer.indexOf("// Payouts count", start),
  );
  assert.match(entry, /tradingOffered\(\)/);
  assert.doesNotMatch(entry, /raisesOffered/);
});

test("the launch page offers no sale button and opens no bid without raises", () => {
  const page = source("./LaunchDetailPage.tsx");
  assert.match(
    page,
    /mainAction === null \|\| !raisesOffered\(\) \? null : \(/,
  );
  assert.match(page, /if \(raisesOffered\(\)\) setBidOpen\(true\);/);
  assert.match(page, /\{bidOpen && raisesOffered\(\) \? \(/);
});

test("the raise sandbox leads elsewhere without raises", () => {
  const launch = source("../../../app/routes/launchpad.$launchId.tsx");
  assert.match(launch, /params\.launchId === SANDBOX_ID && !raisesOffered\(\)/);
});

test("every launch listing leaves raises out without them", () => {
  for (const [file, pattern] of [
    ["./LaunchesPage.tsx", /listedHere\(launch\.record, raises\)/],
    // The social rail's project list: the rule lives in lib/rail.ts, the block passes the setting in.
    [
      "../../social/lib/rail.ts",
      /listedProject\(launch\.record, stage, raises\)/,
    ],
    // The one listing rule those two go through ends in the same check.
    ["../lib/listing.ts", /return listedHere\(record, raises\);/],
    [
      "../../social/ui/RightRail.tsx",
      /railProjects\(launches\.data \?\? \[\], raises\)/,
    ],
    [
      "../../discover/ui/CategoryBrowse.tsx",
      /listedProject\(launch\.record, effectiveStage\(launch\), raises\)/,
    ],
    ["../../discover/use-discover.ts", /raises: raisesOffered\(\)/],
    [
      "../../portfolio/ui/PortfolioPage.tsx",
      /listedHere\(launch\.record, raises\)/,
    ],
  ]) {
    assert.match(source(file), pattern, file);
  }
});

test("the launchpad's sale tabs and funding chips stay behind the setting", () => {
  const page = source("./LaunchesPage.tsx");
  assert.match(
    page,
    /\.filter\(\(f\) => raises \|\| !SALE_FILTERS\.has\(f\)\)/,
  );
  assert.match(
    page,
    /\{raises \? \(\s*<div\s+className=\{cn\(\s*"flex flex-col gap-2"/,
  );
});

test("the funding badge and the project header say nothing about sales without raises", () => {
  const widgets = source("./widgets.tsx");
  assert.match(widgets, /fundingLine\(funding, raisesOffered\(\)\)/);
  const note = source("./ContributorStatusNote.tsx");
  assert.match(
    note,
    /raisesOffered\(\) \? chip\(status\.start, Ban, "contributor-note"\) : null/,
  );
});

test("the pitch board promises no percentage seats and no raise without raises", () => {
  const chip = source("../../projects/ui/ProjectCardFrame.tsx");
  assert.match(
    chip,
    /raisesOffered\(\) \? `\$\{role\.label\} · \$\{role\.pct\}%` : role\.label/,
  );
  const board = source("../../projects/ui/BoardPage.tsx");
  assert.match(board, /to="\/start\/contributor"/);
  assert.match(board, /\{raises \? \(\s*<PitchDialog/);
});

test("the contributor project's DAO card on Discover shows no address", () => {
  const cards = source("../../discover/ui/DiscoverCards.tsx");
  const start = cards.indexOf("function ContributorDaoCard(");
  const end = cards.indexOf("export function DiscoverDaoCard(");
  assert.ok(start >= 0 && end > start, "ContributorDaoCard is found");
  const body = cards.slice(start, end);
  assert.doesNotMatch(body, /AddressLine|addressUrl|font-mono/);
  assert.match(body, /Open project/);
});

test("the Trading card renders nothing unless the build names a market factory and sets the trial switch", () => {
  const card = source("./TradingCard.tsx");
  assert.match(card, /if \(!tradingOffered\(\)\) return null;/);
  const offered = source("../lib/trading-offered.ts");
  assert.match(
    offered,
    /return tradingTrialOn\(env\) && secondaryMarketNamed\(env\);/,
  );
  // Trading no longer depends on raises (the contributor-only image has none), only on the two explicit settings.
  assert.doesNotMatch(offered, /raisesOffered\(/);
});

test("the default build and the pilot image show no trading: neither names a factory or the trial switch", () => {
  // The Dockerfile defaults and compose pass nothing for the market factory or the switch unless an operator sets
  // them, and the build check refuses either alone. The default is empty, so the card is absent.
  const docker = readFileSync(
    fileURLToPath(new URL("../../../../../Dockerfile", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(docker, /^ARG VITE_TRADING_TRIAL=.+$/m);
  assert.doesNotMatch(docker, /^ARG VITE_SECONDARY_MARKET_FACTORY=.+$/m);
  assert.doesNotMatch(docker, /^ARG VITE_TEST_QUOTE_TOKENS=.+$/m);
  assert.doesNotMatch(docker, /export VITE_TRADING_TRIAL/);
});
