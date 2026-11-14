import assert from "node:assert/strict";
import test from "node:test";

import {
  notContributorOnlyBuild,
  courtOffered,
  identityDemoOffered,
  linkDeviceOffered,
} from "./build-gates.ts";

const HOSTED = { VITE_CONTRIBUTOR_ONLY: "1" };

test("the court opens only where the default chain names one", () => {
  assert.equal(courtOffered({}, false), false);
  assert.equal(courtOffered(HOSTED, false), false);
  // A dev server defaults to the local chain; a court named there opens the page.
  assert.equal(
    courtOffered(
      { VITE_COURTS: JSON.stringify({ 31337: `0x${"1".repeat(40)}` }) },
      true,
    ),
    true,
  );
  // A court on another chain than the default one does not.
  assert.equal(
    courtOffered(
      { VITE_COURTS: JSON.stringify({ 84532: `0x${"1".repeat(40)}` }) },
      true,
    ),
    false,
  );
});

test("the passkey prototype never opens in the hosted build unless asked for", () => {
  assert.equal(identityDemoOffered(HOSTED, false), false);
  assert.equal(
    identityDemoOffered({ ...HOSTED, VITE_IDENTITY_DEMO: "1" }, false),
    true,
  );
  assert.equal(identityDemoOffered(HOSTED, true), true);
  // The developer and test builds (where the passkey specs run) keep it.
  assert.equal(identityDemoOffered({}, false), true);
});

test("the desktop hand-off opens only in a build with the desktop app", () => {
  assert.equal(linkDeviceOffered({}), false);
  assert.equal(linkDeviceOffered(HOSTED), false);
  assert.equal(linkDeviceOffered({ VITE_DESKTOP_APP: "1" }), true);
  assert.equal(linkDeviceOffered({ VITE_DESKTOP_APP: "0" }), false);
});

test("the Projects board, code browsing, the sale list and AI helpers stay out of the hosted build", () => {
  assert.equal(notContributorOnlyBuild(HOSTED), false);
  assert.equal(notContributorOnlyBuild({}), true);
  assert.equal(notContributorOnlyBuild(undefined), true);
});
