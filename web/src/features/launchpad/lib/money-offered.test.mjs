import assert from "node:assert/strict";
import { test } from "node:test";

import { contributorKitNamed, moneyOffered } from "./money-offered.ts";

const KIT = `{"31337":"0x${"b2".repeat(20)}"}`;
const FACTORY = `{"31337":"0x${"fa".repeat(20)}"}`;

/** The hosted pilot: no sales, investing off, no kit. */
const PILOT = { VITE_CONTRIBUTOR_ONLY: "1" };

test("a build with no sales, investing off and no contributor kit has no money on it", () => {
  assert.equal(moneyOffered(PILOT), false);
  // An empty or broken kit setting names nothing.
  assert.equal(moneyOffered({ ...PILOT, VITE_CONTRIBUTOR_KITS: "" }), false);
  assert.equal(moneyOffered({ ...PILOT, VITE_CONTRIBUTOR_KITS: "{}" }), false);
  // The switch alone, with no pool factory, is not investing.
  assert.equal(moneyOffered({ ...PILOT, VITE_INVESTING: "1" }), false);
});

test("any one of sales, investing or a contributor kit brings the money cards back", () => {
  assert.equal(moneyOffered({}), true);
  assert.equal(moneyOffered(undefined), true);
  assert.equal(moneyOffered({ ...PILOT, VITE_CONTRIBUTOR_KITS: KIT }), true);
  assert.equal(
    moneyOffered({
      ...PILOT,
      VITE_INVESTING: "1",
      VITE_BACKING_POOL_FACTORY: FACTORY,
    }),
    true,
  );
});

test("a contributor kit is named by the plain kit, or by the pooled one only where investing is on", () => {
  assert.equal(contributorKitNamed({}), false);
  assert.equal(contributorKitNamed({ VITE_CONTRIBUTOR_KITS: KIT }), true);
  assert.equal(contributorKitNamed({ VITE_CONTRIBUTOR_KIT_V3: KIT }), false);
  assert.equal(
    contributorKitNamed({
      VITE_CONTRIBUTOR_KIT_V3: KIT,
      VITE_INVESTING: "1",
      VITE_BACKING_POOL_FACTORY: FACTORY,
    }),
    true,
  );
});
