// Wizard pure-layer guards: time→block conversion, the wizard state machine,
// unlock presets, sale plans, and the wizard→input encoding — including the
// Rule-1 edit-preservation invariant (a wizard save must not erase record
// fields whose editors live outside the wizard).
import test from "node:test";
import assert from "node:assert/strict";

import {
  blocksForSeconds,
  describeSaleBlocks,
  planSaleBlocks,
  secondsPerBlockFrom,
  CLAIM_DELAY_SECONDS,
} from "./time-blocks.ts";
import {
  BUDGET_SHARES,
  budgetForShare,
  budgetCapMessage,
  deriveSymbol,
  initialWizardState,
  nextStep,
  previousStep,
  renumberMilestones,
  slugFromName,
  totalFromTranche,
  trancheFromTotal,
  wizardToCreateInput,
} from "./wizard.ts";
import {
  equalMilestoneSplit,
  MAX_MILESTONES,
  MIN_MILESTONES,
  milestoneClaimId,
  SHORT_VESTING_MONTHS,
} from "./unlock-plans.ts";
import {
  isSaleKind,
  MAX_SALE_SECONDS,
  SALE_KINDS,
  durationSecondsFor,
} from "./sale-plans.ts";

// ─── time-blocks ─────────────────────────────────────────────────────────

test("secondsPerBlockFrom answers null when no sample qualifies", () => {
  assert.equal(secondsPerBlockFrom([]), null);
  assert.equal(
    secondsPerBlockFrom([
      { block: 1, timestampSeconds: 100 },
      { block: 2, timestampSeconds: 50 },
    ]),
    null,
    "non-increasing gaps are discarded — the caller falls back to the table",
  );
  assert.equal(
    secondsPerBlockFrom([
      { block: 1, timestampSeconds: 100 },
      { block: 7, timestampSeconds: 112 },
    ]),
    null,
    "non-consecutive blocks never form a gap",
  );
});

test("secondsPerBlockFrom measures the sampled spacing", () => {
  const spb = secondsPerBlockFrom([
    { block: 12, timestampSeconds: 1004 },
    { block: 13, timestampSeconds: 1006 },
    { block: 10, timestampSeconds: 1000 },
    { block: 14, timestampSeconds: 1012 },
  ]);
  // consecutive gaps only: 12→13 = 2s, 13→14 = 6s → median (2+6)/2 = 4
  assert.equal(spb, 4);
});

test("blocksForSeconds converts with the given rate", () => {
  assert.equal(blocksForSeconds(60, 2), 30);
  assert.equal(blocksForSeconds(1, 2), 1, "sub-block durations round up to 1");
  assert.equal(blocksForSeconds(0, 2), 0);
});

test("planSaleBlocks: start buffer, end safety margin, claim delay", () => {
  const plan = planSaleBlocks({
    head: 1_000,
    nowSeconds: 1_700_000_000,
    secondsPerBlock: 2,
    source: "measured",
    durationSeconds: 86_400,
  });
  assert.ok(plan, "a valid input yields a plan");
  assert.equal(plan.source, "measured");
  assert.ok(plan.startBlock > 1_000, "starts past the head (publish buffer)");
  // end = request + margin; margin lands exactly END_SAFETY_MARGIN_BPS of the window
  assert.ok(plan.marginBlocks > 0, "a slow chain cannot end the sale early");
  assert.ok(
    plan.endBlock > plan.startBlock,
    "end after start even at 2 s/block",
  );
  assert.equal(
    plan.claimBlock - plan.endBlock,
    Math.ceil(CLAIM_DELAY_SECONDS / 2),
    "claim opens a fixed half-day delay after the end",
  );
  assert.ok(
    describeSaleBlocks(plan).length > 0,
    "the human summary is non-empty",
  );
});

test("planSaleBlocks rejects unusable windows", () => {
  assert.equal(
    planSaleBlocks({
      head: 1_000,
      nowSeconds: 1_700_000_000,
      secondsPerBlock: 2,
      durationSeconds: -10,
    }),
    null,
  );
  assert.equal(
    planSaleBlocks({
      head: -5,
      nowSeconds: 1_700_000_000,
      secondsPerBlock: 2,
      durationSeconds: 60,
    }),
    null,
    "a negative head is unusable",
  );
  assert.equal(
    planSaleBlocks({
      head: 1_000,
      nowSeconds: 1_700_000_000,
      secondsPerBlock: 0,
      durationSeconds: 60,
    }),
    null,
    "zero seconds-per-block is unusable",
  );
});

// ─── wizard state machine ────────────────────────────────────────────────

test("wizard steps walk token → sale → unlocks → dao", () => {
  assert.equal(nextStep("token"), "sale");
  assert.equal(nextStep("sale"), "unlocks");
  assert.equal(nextStep("unlocks"), "dao");
  assert.equal(nextStep("dao"), null);
  assert.equal(previousStep("sale"), "token");
  assert.equal(previousStep("token"), null);
});

test("initial wizard state is the short-term conviction default", () => {
  const w = initialWizardState();
  assert.equal(w.saleKind, "graduating-auction");
  assert.equal(w.durationKey, "7d");
  assert.equal(w.unlockMode, "milestones");
  assert.equal(w.formDao, true);
  assert.deepEqual(
    w.milestones.map((m) => m.percent),
    [25, 25, 25, 25],
  );
  assert.deepEqual(
    w.milestones.map((m) => m.claim),
    ["m1", "m2", "m3", "m4"],
  );
});

test("tranche ↔ total round-trips through the sale percentage", () => {
  for (const salePercent of [10, 25, 40]) {
    const total = totalFromTranche("1000000", salePercent);
    assert.equal(trancheFromTotal(total, salePercent), "1000000");
  }
});

test("renumberMilestones keeps claim ids sequential", () => {
  const rows = renumberMilestones([
    { claim: "m9", label: "a", percent: 25 },
    { claim: "zz", label: "b", percent: 25 },
    { claim: "m3", label: "c", percent: 25 },
    { claim: "m4", label: "d", percent: 25 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.claim),
    ["m1", "m2", "m3", "m4"],
  );
});

test("name-derived helpers are stable", () => {
  assert.equal(slugFromName("My Great Project!"), "my-great-project");
  assert.equal(
    deriveSymbol("Pixel Movie"),
    "PIXE",
    "symbols cap at 4 characters",
  );
});

test("budget share table + cap messaging", () => {
  assert.ok(BUDGET_SHARES.includes(15));
  assert.equal(budgetForShare("1200000", 10), "120000");
  assert.equal(
    budgetCapMessage("120000", "1200000"),
    null,
    "within cap says nothing",
  );
  const msg = budgetCapMessage("300000", "1200000");
  assert.ok(msg && msg.length > 0, "over cap explains");
});

// ─── unlock plans ────────────────────────────────────────────────────────

test("equal milestone splits sum to 100 across the allowed range", () => {
  for (let count = MIN_MILESTONES; count <= MAX_MILESTONES; count++) {
    const split = equalMilestoneSplit(count);
    assert.equal(split.length, count);
    assert.equal(
      split.reduce((a, b) => a + b, 0),
      100,
      `${count} milestones split exactly 100%`,
    );
  }
  assert.deepEqual(equalMilestoneSplit(4), [25, 25, 25, 25]);
});

test("milestone claim ids are the canonical m<n> ladder", () => {
  assert.equal(milestoneClaimId(0), "m1");
  assert.equal(milestoneClaimId(3), "m4");
});

test("short vesting is short: 3 and 6 months only", () => {
  assert.deepEqual([...SHORT_VESTING_MONTHS], [3, 6]);
});

// ─── sale plans ──────────────────────────────────────────────────────────

test("sale kinds and durations cover the presets", () => {
  assert.ok(SALE_KINDS.includes("graduating-auction"));
  assert.ok(SALE_KINDS.includes("fixed-price"));
  assert.ok(isSaleKind("fixed-price"));
  assert.equal(isSaleKind("nonsense"), false);
  assert.equal(durationSecondsFor("3d"), 3 * 86_400);
  assert.equal(durationSecondsFor("7d"), 7 * 86_400);
  assert.equal(durationSecondsFor("14d"), 14 * 86_400);
  assert.equal(durationSecondsFor("custom"), null, "custom needs a date");
  assert.ok(MAX_SALE_SECONDS >= 14 * 86_400, "presets fit under the cap");
});

// ─── wizardToCreateInput: the Rule-1 edit-preservation invariant ─────────

function baseForm() {
  return {
    id: "launch-1",
    name: "Pixel Movie",
    pitch: "A short film",
    longPitch: "",
    ipList: "",
    updateCadence: "weekly",
    chainId: "31337",
    currency: "0x1613beb3b2c4f22ee086b2b38c1476a3ce7f78e8",
    floorPrice: "0",
    tickSpacing: "0",
    requiredRaised: "10000",
    budget: "1000",
    auction: "",
    treasury: "0x0000000000000000000000000000000000000001",
    admission: "curated",
    channels: ["general"],
    allocation: {
      sale: 25,
      team: 15,
      treasury: 30,
      liquidity: 10,
      milestones: 15,
      community: 5,
    },
    vesting: null,
    vestingPresent: false,
    vestingDirty: false,
    tokenMode: "mint",
    tokenName: "Pixel Movie",
    symbol: "PIXEL",
    supply: "1000000",
    importAddress: "",
    asAgent: false,
    startBlock: 111,
    endBlock: 222,
    claimBlock: 333,
    unlocks: {
      mode: "milestones",
      verifier: "founder",
      milestones: [
        { claim: "m1", label: "pilot", percent: 50 },
        { claim: "m2", label: "release", percent: 50 },
      ],
    },
    daoAtGraduation: true,
  };
}

test("wizardToCreateInput preserves record fields it has no editor for", () => {
  const form = baseForm();
  const wizard = initialWizardState();
  const input = wizardToCreateInput(form, wizard, {
    plan: null,
    rawBlocks: { startBlock: 111, endBlock: 222, claimBlock: 333 },
  });
  assert.equal(input.id, "launch-1");
  assert.equal(input.startBlock, 111);
  assert.equal(input.endBlock, 222);
  assert.equal(input.claimBlock, 333);
  assert.equal(input.daoAtGraduation, true, "the DAO choice is never dropped");
  assert.ok(input.unlocks, "the unlock plan survives the round trip");
  assert.equal(input.unlocks.milestones.length, 2);
  assert.equal(input.unlocks.milestones[0].label, "pilot");
});

test("wizardToCreateInput carries the wizard's own plan when supplied", () => {
  const form = baseForm();
  const wizard = initialWizardState({
    unlockMode: "time",
    months: 6,
  });
  const input = wizardToCreateInput(form, wizard, {
    plan: null,
    rawBlocks: { startBlock: 5, endBlock: 500, claimBlock: 700 },
  });
  assert.equal(input.startBlock, 5);
  assert.equal(input.endBlock, 500);
  assert.equal(input.claimBlock, 700);
  assert.equal(input.unlocks.mode, "time", "the wizard's unlock choice wins");
});

test("token fields flow from the wizard-visible inputs", () => {
  const form = baseForm();
  const input = wizardToCreateInput(form, initialWizardState(), {
    plan: null,
    rawBlocks: { startBlock: 1, endBlock: 2, claimBlock: 3 },
  });
  assert.equal(input.name, "Pixel Movie");
  assert.equal(input.tokenPlan.supply, "1000000");
});
