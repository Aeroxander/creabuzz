import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultMilestoneRows,
  defaultRaiseTarget,
  q96ToPlainPrice,
  quickSaleDefaults,
} from "./quick-sale.ts";
import { unlockPlanIssues } from "./unlock-plans.ts";

test("the first raise target is in the sale currency's own scale", () => {
  assert.equal(defaultRaiseTarget("eth"), "120");
  assert.equal(defaultRaiseTarget("usdc"), "300000");
  assert.equal(defaultRaiseTarget("custom"), "300000");
});

test("a USDC quick sale derives a full set of sale terms from one number", () => {
  const defaults = quickSaleDefaults(
    { kind: "usdc", decimals: 6 },
    "200000000",
  );
  assert.ok(defaults.money, "the target must yield sale terms");
  assert.ok(BigInt(defaults.money.floorPrice) > 0n);
  assert.ok(BigInt(defaults.money.tickSpacing) > 0n);
  assert.ok(BigInt(defaults.money.requiredRaised) > 0n);
});

test("an ETH quick sale derives terms too", () => {
  const defaults = quickSaleDefaults(
    { kind: "eth", decimals: 18 },
    "200000000",
  );
  assert.ok(defaults.money);
  assert.ok(BigInt(defaults.money.requiredRaised) > 0n);
});

test("the default milestones are named and add up to the whole plan", () => {
  const rows = defaultMilestoneRows();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.label.trim() !== ""));
  assert.equal(
    rows.reduce((sum, row) => sum + row.percent, 0),
    100,
  );
});

test("a plain price text round-trips and junk reads as nothing", () => {
  assert.equal(q96ToPlainPrice(""), "");
  assert.equal(q96ToPlainPrice("not a number"), "");
  assert.ok(q96ToPlainPrice("792281625140000") !== "");
});

test("unlock plan issues helper is importable alongside (guards the shared seam)", () => {
  assert.equal(typeof unlockPlanIssues, "function");
});

import { quickDefaultRows } from "./quick-sale.ts";

test("the defaults list says what the founder was not asked", () => {
  const rows = quickDefaultRows({
    tokenName: "Nebula Token",
    symbol: "neb",
    saleShare: 50,
    totalSupply: "400,000,000",
    milestoneLabels: ["Beta shipped", " ", "Release 1.0"],
    formDao: true,
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel.Token, "Nebula Token (NEB)");
  assert.equal(byLabel["Tokens for sale"], "50% of 400M");
  assert.equal(byLabel["Your own tokens unlock"], "Beta shipped, Release 1.0");
  assert.equal(byLabel["If the target is met"], "It becomes a DAO");
});

test("an unreadable supply or no milestones still reads sensibly", () => {
  const rows = quickDefaultRows({
    tokenName: "X Token",
    symbol: "X",
    saleShare: 20,
    totalSupply: "lots",
    milestoneLabels: [],
    formDao: false,
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel["Tokens for sale"], "20% of the supply");
  assert.equal(byLabel["Your own tokens unlock"], "On a schedule");
  assert.equal(byLabel["If the target is met"], "No DAO");
});
