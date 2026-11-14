import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The pilot build is contributor-only (`raisesOffered()` false) and web-only (`DESKTOP_APP` false). The mocked browser
 * suite runs one ordinary build and cannot switch either setting per test, so, as in
 * `contributorOnlyGatesContract.test.mjs`, the components' source is the seam for the gates that live in them. The rules
 * themselves are tested on their own (`contributor-only.test.mjs`, `raises-offered.test.mjs`).
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("sign-up offers no wallet without raises", () => {
  const dialog = source("../../identity/ui/OnboardingDialog.tsx");
  assert.match(dialog, /\{raisesOffered\(\) && walletAvailable\(\) \? \(/);
  assert.doesNotMatch(dialog, /\{walletAvailable\(\) \? \(/);
});

test("a cashtag resolves only to a launch this build lists, and shows no price without raises", () => {
  const hook = source("../../social/use-cashtags.ts");
  assert.match(hook, /const raises = raisesOffered\(\);/);
  // The one listing rule (`listing.ts`), which leaves raises out without them (`listedHere`).
  assert.match(
    hook,
    /listedProject\(launch\.record, effectiveStage\(launch\), raises\)/,
  );
  assert.match(
    hook,
    /raises\s*\?\s*launch\s*:\s*\{\s*\.\.\.launch,\s*bids: \[\],\s*record: \{ \.\.\.launch\.record, floorPrice: null \}/,
  );
});

test("the community page offers the desktop app only in a build that has it", () => {
  const page = source("./CommunityHomePage.tsx");
  assert.match(page, /\{DESKTOP_APP \? \(\s*<Button/);
  assert.match(page, /Join this community/);
  assert.doesNotMatch(page, /Join in browser/);
});
