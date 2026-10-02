/**
 * The create-launch wizard: state, validation, and the one place a wizard
 * choice becomes a published record.
 *
 * The dialog (`../ui/CreateLaunchDialog.tsx`) owns React state; everything it
 * decides lives here so it can be tested without a DOM — step validation,
 * preset adoption, the percent sum, the budget cap, and the derivation of the
 * auction parameters the contract consumes.
 *
 * Two seams are deliberately exported and used by production code:
 *
 * - {@link buildLegacyInput} is today's form submit, verbatim — the edit
 *   dialog calls it, and the parity test drives it against the wizard's
 *   output, so "the wizard publishes what the old form published" is a
 *   property of shared code rather than of two copies of it.
 * - {@link wizardToCreateInput} is the wizard's submit: the legacy mapping,
 *   with the wizard's choices and the time-derived block window written over
 *   it. Anything the Advanced drawer edits passes straight through, because it
 *   *is* the same state the legacy mapping reads.
 *
 * Plain language is enforced at the edge: chain concepts (Q96 prices, base
 * units, blocks) appear only where the old form already exposed them, inside
 * the Advanced drawer.
 *
 * Alias-free on purpose: `wizard.test.mjs` drives it under `node --test`.
 */

import type { CreateLaunchInput } from "../use-launches.ts";
import {
  isEvmAddress,
  isLaunchSlug,
  isWholeTokenSupply,
  suggestSymbol,
  type LaunchStage,
  type VestingConfig,
} from "../models.ts";
import {
  hasBlockingIssue,
  validateLaunchParams,
  type AuctionStepInput,
  type LaunchParamIssue,
} from "./launch-params.ts";
import { allocationIssue, type SupplyAllocation } from "./allocation.ts";
import {
  DEFAULT_PERFORMANCE_TRANCHES,
  validateVesting,
} from "./vesting-params.ts";
import { saleCurrencyFor } from "./sale-currency.ts";
import {
  durationSecondsFor,
  floorFromPrice,
  floorFromRaiseTarget,
  MAX_SALE_SECONDS,
  priceToAtomic,
  SALE_DURATIONS,
  SALE_PLANS,
  scheduleFor,
  thresholdFromFloor,
  type DurationPreset,
  type SaleKind,
} from "./sale-plans.ts";
import {
  endSecondsFromDateInput,
  planSaleBlocks,
  type SaleBlockPlan,
} from "./time-blocks.ts";
import {
  encodeUnlockPlan,
  equalMilestoneSplit,
  milestoneClaimId,
  unlockPlanIssues,
  type UnlockMode,
  type UnlockPlan,
} from "./unlock-plans.ts";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type WizardStep = "token" | "sale" | "unlocks" | "dao";

export interface WizardStepMeta {
  key: WizardStep;
  label: string;
  title: string;
  blurb: string;
}

export const WIZARD_STEPS: readonly WizardStepMeta[] = [
  {
    key: "token",
    label: "Token",
    title: "Your token",
    blurb: "Name, symbol, and how much there is.",
  },
  {
    key: "sale",
    label: "Sale",
    title: "Your sale",
    blurb: "How it sells, how long it runs, and what it raises.",
  },
  {
    key: "unlocks",
    label: "Unlocks",
    title: "Your unlocks",
    blurb: "What your own allocation releases against.",
  },
  {
    key: "dao",
    label: "DAO",
    title: "Your DAO",
    blurb: "Whether this becomes a DAO at graduation, and its budget.",
  },
];

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.findIndex((meta) => meta.key === step);
}

export function nextStep(step: WizardStep): WizardStep | null {
  const index = stepIndex(step);
  return WIZARD_STEPS[index + 1]?.key ?? null;
}

export function previousStep(step: WizardStep): WizardStep | null {
  const index = stepIndex(step);
  return index <= 0 ? null : WIZARD_STEPS[index - 1].key;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type PricingMode = "price" | "raise";
export type DurationKey = DurationPreset["key"];

/** One editable milestone line of step 3. */
export interface MilestoneRow {
  claim: string;
  label: string;
  percent: number;
}

export interface WizardState {
  step: WizardStep;
  saleKind: SaleKind;
  durationKey: DurationKey;
  /** `yyyy-mm-dd` for the custom end date, empty until picked. */
  endDate: string;
  pricingMode: PricingMode;
  /** Plain per-token price, e.g. "0.01". */
  price: string;
  /** Plain raise target in whole currency, e.g. "300000". */
  raiseTarget: string;
  unlockMode: UnlockMode;
  milestones: MilestoneRow[];
  months: number;
  formDao: boolean;
  /**
   * Legal wrapper (the entity decision, OAv2 §4.8): "none" (default —
   * explicitly fine), "dao-llc", or "own-entity". Decided before token
   * launch; "none" now is a choice, not a gap.
   */
  legalWrapper: string;
}

/**
 * The form's own fields — exactly what today's submit reads, so the edit
 * dialog and the wizard share one mapping (`buildLegacyInput`).
 */
export interface FormState {
  id: string;
  name: string;
  pitch: string;
  longPitch: string;
  ipList: string;
  updateCadence: string;
  chainId: string;
  currency: string;
  /** Q96 floor price, chain units (Advanced drawer). */
  floorPrice: string;
  /** Tick spacing, chain units (Advanced drawer). */
  tickSpacing: string;
  /** Graduation threshold, currency base units. */
  requiredRaised: string;
  /** Monthly budget, currency base units. */
  budget: string;
  auction: string;
  treasury: string;
  admission: "curated" | "community";
  channels: string[];
  allocation: SupplyAllocation;
  vesting: VestingConfig | null;
  /** The record already carried a ladder — a save must not drop it. */
  vestingPresent: boolean;
  /** The founder changed the ladder in this session. */
  vestingDirty: boolean;
  tokenMode: "mint" | "import";
  tokenName: string;
  symbol: string;
  /** Sale tranche in whole tokens — the record's `tokenPlan.supply`. */
  supply: string;
  importAddress: string;
  asAgent: boolean;
  /**
   * Everything the record already holds that this form has no control over,
   * carried through a save untouched: the sale window, the unlock plan and the
   * DAO-at-graduation choice. Null on a fresh launch. Rule 1 — an edit must
   * not erase a field just because its editor lives in the wizard.
   */
  startBlock: number | null;
  endBlock: number | null;
  claimBlock: number | null;
  unlocks: UnlockPlan | null;
  daoAtGraduation: boolean | null;
}

/** Four equal milestones by default — 25/25/25/25 of the milestone slice. */
export function initialMilestones(count = 4): MilestoneRow[] {
  const percents = equalMilestoneSplit(count);
  return Array.from({ length: count }, (_, index) => ({
    claim: milestoneClaimId(index),
    label: "",
    percent: percents[index],
  }));
}

export function initialWizardState(
  overrides: Partial<WizardState> = {},
): WizardState {
  return {
    step: "token",
    saleKind: "graduating-auction",
    durationKey: "7d",
    endDate: "",
    pricingMode: "price",
    price: "0.01",
    raiseTarget: "",
    unlockMode: "milestones",
    milestones: initialMilestones(4),
    months: 3,
    formDao: true,
    legalWrapper: "none",
    ...overrides,
  };
}

/** Row indexes renumbered so `claim` is always `m<index + 1>`. */
export function renumberMilestones(
  rows: readonly MilestoneRow[],
): MilestoneRow[] {
  return rows.map((row, index) => ({ ...row, claim: milestoneClaimId(index) }));
}

// ---------------------------------------------------------------------------
// Plain-language helpers
// ---------------------------------------------------------------------------

/** `Nebula DAO` → `nebula-dao`; empty when the name says nothing yet. */
export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** What the record's `d` tag will be: the founder's own id, else the slug. */
export function effectiveLaunchId(
  form: Pick<FormState, "id" | "name">,
): string {
  const typed = form.id.trim();
  return typed.length > 0 ? typed : slugFromName(form.name);
}

export function deriveTokenName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "" : `${trimmed} Token`;
}

export function deriveSymbol(name: string): string {
  return suggestSymbol(name);
}

/**
 * Whole-token total → the sale tranche the record stores.
 *
 * The record carries the tranche (the tokenomics card turns it back into the
 * total with the allocation's sale share), so the wizard asks for the number
 * people have in mind — the total — and stores what the record has always
 * stored. `1000000000` at the standard 20% sale tranche is `200000000`,
 * exactly `LAUNCH_DEFAULTS.supply`.
 */
export function trancheFromTotal(total: string, salePercent: number): string {
  const trimmed = total.trim();
  if (!/^\d+$/.test(trimmed)) return "";
  if (!(salePercent > 0)) return trimmed;
  const tokens = BigInt(trimmed);
  return ((tokens * BigInt(Math.round(salePercent))) / 100n).toString();
}

/** The inverse of {@link trancheFromTotal} — what the wizard's field shows. */
export function totalFromTranche(supply: string, salePercent: number): string {
  const trimmed = supply.trim();
  if (!/^\d+$/.test(trimmed)) return "";
  if (!(salePercent > 0)) return trimmed;
  const tokens = BigInt(trimmed);
  return ((tokens * 100n) / BigInt(Math.round(salePercent))).toString();
}

// ---------------------------------------------------------------------------
// Sale derivation
// ---------------------------------------------------------------------------

/** What a sale's money fields become, in the record's chain units. */
export interface SalePatch {
  floorPrice: string;
  tickSpacing: string;
  requiredRaised: string;
}

/** Tokens the auction offers, in 18-decimal units. */
export function saleTokensFromSupply(supply: string): bigint {
  const trimmed = supply.trim();
  if (!/^\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed) * 10n ** 18n;
}

/**
 * A typed price → the three money fields, using the sale type's graduation
 * line. Null when the price cannot be read — the caller leaves the fields
 * alone and the step says why.
 */
export function patchForPrice(
  price: string,
  saleKind: SaleKind,
  supply: string,
  currencyDecimals = 6,
): SalePatch | null {
  const floor = floorFromPrice(price, currencyDecimals);
  if (!floor) return null;
  const requiredRaised = thresholdFromFloor({
    saleTokens: saleTokensFromSupply(supply),
    floorPrice: floor.floorPrice,
    thresholdPercent: SALE_PLANS[saleKind].thresholdPercent,
  });
  return {
    floorPrice: floor.floorPrice.toString(),
    tickSpacing: floor.tickSpacing.toString(),
    requiredRaised: requiredRaised.toString(),
  };
}

/** A typed raise target → the same three fields, priced to reach the target. */
export function patchForRaiseTarget(
  raiseTarget: string,
  saleKind: SaleKind,
  supply: string,
  currencyDecimals = 6,
): SalePatch | null {
  const target = priceToAtomic(raiseTarget, currencyDecimals);
  if (target === null || target <= 0n) return null;
  const floor = floorFromRaiseTarget({
    raiseTarget: target,
    saleTokens: saleTokensFromSupply(supply),
    thresholdPercent: SALE_PLANS[saleKind].thresholdPercent,
  });
  if (!floor) return null;
  return {
    floorPrice: floor.floorPrice.toString(),
    tickSpacing: floor.tickSpacing.toString(),
    requiredRaised: target.toString(),
  };
}

// ---------------------------------------------------------------------------
// Budget share (the cap rule, in the units the founder thinks in)
// ---------------------------------------------------------------------------

/** The share dropdown's options. Anything else reads as "set in Advanced". */
export const BUDGET_SHARES = [0, 5, 10, 15, 20, 25] as const;

export function toBigint(value: string): bigint {
  const trimmed = value.trim();
  if (trimmed === "") return 0n;
  if (!/^\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

/**
 * The current budget as a share of the raise target, or `"custom"` when it
 * was typed by hand in the Advanced drawer. `0` means "no budget".
 */
export function budgetShare(
  budget: string,
  requiredRaised: string,
): number | "custom" {
  const budgetAtomic = toBigint(budget);
  if (budgetAtomic === 0n) return 0;
  const target = toBigint(requiredRaised);
  if (target === 0n) return "custom";
  const exact = Number((budgetAtomic * 10_000n) / target) / 100;
  return BUDGET_SHARES.some((share) => share === exact) ? exact : "custom";
}

/** A share of the raise target, in currency base units. */
export function budgetForShare(
  requiredRaised: string,
  sharePercent: number,
): string {
  const target = toBigint(requiredRaised);
  if (target === 0n || sharePercent <= 0) return "";
  return ((target * BigInt(Math.round(sharePercent))) / 100n).toString();
}

/**
 * The one rule that bites: a monthly budget above a sixth of the raise target
 * means the treasury can spend faster than the raise refills it.
 *
 * The message is `validateLaunchParams`' own wording — the warning the record
 * already carries — so the dialog and the issue list cannot disagree.
 */
export function budgetCapMessage(
  budget: string,
  requiredRaised: string,
): string | null {
  const issues = validateLaunchParams({
    supply: 1n,
    floorPrice: 1n,
    tickSpacing: 2n,
    requiredCurrencyRaised: toBigint(requiredRaised),
    budget: toBigint(budget),
    startBlock: 0n,
    endBlock: 1n,
    claimBlock: 1n,
    steps: [{ mps: 1n, blockDelta: 1n }],
  });
  return issues.find((issue) => issue.field === "budget")?.message ?? null;
}

// ---------------------------------------------------------------------------
// Unlock plan
// ---------------------------------------------------------------------------

/** The plan step 3 produces, for the record's `unlocks` field. */
export function unlockPlanFromWizard(
  wizard: WizardState,
  allocation: SupplyAllocation,
): UnlockPlan {
  return {
    mode: wizard.unlockMode,
    allocationPct: allocation.milestones,
    milestones:
      wizard.unlockMode === "milestones"
        ? wizard.milestones.map((row) => ({
            claim: row.claim,
            label: row.label.trim(),
            percent: row.percent,
            verifier: "founder" as const,
          }))
        : [],
    months: wizard.unlockMode === "time" ? wizard.months : null,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Step-local problems. Empty means the step may be left. `now` is the seam. */
export function wizardStepIssues(
  wizard: WizardState,
  form: FormState,
  step: WizardStep = wizard.step,
  now: number = nowSeconds(),
): string[] {
  const issues: string[] = [];
  if (step === "token") {
    if (form.name.trim().length === 0) issues.push("Give the launch a name.");
    if (form.symbol.trim().length === 0) {
      issues.push("The token needs a symbol.");
    }
    if (!isWholeTokenSupply(form.supply) || BigInt(form.supply) === 0n) {
      issues.push("Total supply must be a whole number greater than zero.");
    } else if (!(form.allocation.sale > 0)) {
      issues.push(
        "Give the sale a share of the tokens so there is something to sell.",
      );
    }
    const split = allocationIssue(form.allocation);
    if (split) issues.push(split);
    const id = effectiveLaunchId(form);
    if (!isLaunchSlug(id)) {
      issues.push(
        "Launch id must be lowercase letters, digits, dashes or underscores.",
      );
    }
    if (
      form.tokenMode === "import" &&
      !/^0x[0-9a-fA-F]{40}$/.test(form.importAddress.trim())
    ) {
      issues.push("Paste the token contract you are importing.");
    }
  }
  if (step === "sale") {
    // The units the founder types in are the sale currency's: ETH has 18
    // decimals, USDC 6. Examples in the messages follow it.
    const currency = saleCurrencyFor(form.currency, form.chainId);
    const decimals = currency.decimals;
    if (wizard.pricingMode === "price") {
      if (
        patchForPrice(wizard.price, wizard.saleKind, form.supply, decimals) ===
        null
      ) {
        issues.push(
          `Enter a price per token in ${currency.symbol}, for example ${currency.kind === "eth" ? "0.000004" : "0.01"}.`,
        );
      }
    } else if (
      patchForRaiseTarget(
        wizard.raiseTarget,
        wizard.saleKind,
        form.supply,
        decimals,
      ) === null
    ) {
      issues.push(
        `Enter what the sale needs to raise in ${currency.symbol}, for example ${currency.kind === "eth" ? "120" : "300000"}.`,
      );
    }
    if (wizard.durationKey === "custom") {
      const endAt = endSecondsFromDateInput(wizard.endDate, now);
      if (endAt === null) {
        issues.push("Pick an end date in the future.");
      } else if (endAt - now > MAX_SALE_SECONDS) {
        issues.push("A sale runs for at most 180 days.");
      }
    }
  }
  if (step === "unlocks") {
    for (const issue of unlockPlanIssues(
      unlockPlanFromWizard(wizard, form.allocation),
    )) {
      if (issue.severity === "error") issues.push(issue.message);
    }
  }
  if (step === "dao") {
    if (form.budget.trim() !== "" && !/^\d+$/.test(form.budget.trim())) {
      issues.push("Monthly budget must be a whole number of base units.");
    }
  }
  return issues;
}

/**
 * The clock seam: step validation needs "now", so it is a parameter of
 * {@link wizardStepIssues} whose default is this — tests pass their own.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Everything that makes the *whole* form unpublishable — the contract's rules
 * (`validateLaunchParams`, blocking only) plus the allocation adding up. The
 * dialog renders the full list, warnings included, exactly as before.
 */
/**
 * The window the wizard will write, as the validator wants it. Passing it
 * means the schedule and the block bounds are checked for real; passing null
 * means "no window yet" (the chain could not be read, or the edit form never
 * had one) and the window rules are skipped exactly as the old form skipped
 * them — a check against placeholder zeros would only produce fiction.
 */
export interface ValidationWindow {
  startBlock: bigint;
  endBlock: bigint;
  claimBlock: bigint;
  steps: AuctionStepInput[];
}

export function publishIssues(
  form: FormState,
  window: ValidationWindow | null = null,
): LaunchParamIssue[] {
  const issues = validateLaunchParams({
    supply: saleTokensFromSupply(form.supply),
    floorPrice: toBigint(form.floorPrice),
    tickSpacing: toBigint(form.tickSpacing),
    requiredCurrencyRaised: toBigint(form.requiredRaised),
    budget: toBigint(form.budget),
    startBlock: window?.startBlock ?? 0n,
    endBlock: window?.endBlock ?? 0n,
    claimBlock: window?.claimBlock ?? 0n,
    steps: window?.steps ?? [],
  });
  const checked = window !== null;
  const filtered = checked
    ? issues
    : issues.filter(
        (issue) =>
          issue.field !== "steps" &&
          issue.field !== "endBlock" &&
          issue.field !== "claimBlock",
      );
  const allocationMessage = allocationIssue(form.allocation);
  if (allocationMessage !== null) {
    filtered.push({
      field: "allocation",
      severity: "error",
      message: allocationMessage,
    });
  }
  // Form-level checks the old form enforced inline at submit: one validator
  // for every gate (create and edit), so no surface can bypass them.
  const chain = form.chainId.trim();
  if (chain !== "" && !/^\d+$/.test(chain)) {
    filtered.push({
      field: "chainId",
      severity: "error",
      message: "Chain id must be a number, e.g. 11155111.",
    });
  }
  for (const field of ["auction", "treasury"] as const) {
    const value = form[field].trim();
    if (value !== "" && !isEvmAddress(value)) {
      filtered.push({
        field,
        severity: "error",
        message: "Auction and treasury must be 0x addresses when set.",
      });
    }
  }
  return filtered;
}

/** True when the wizard and the contract both allow publishing. */
export function canPublish(
  wizard: WizardState,
  form: FormState,
  window: ValidationWindow | null = null,
): boolean {
  const stepsValid = WIZARD_STEPS.every(
    (meta) => wizardStepIssues(wizard, form, meta.key).length === 0,
  );
  return stepsValid && !hasBlockingIssue(publishIssues(form, window));
}

/**
 * Everything that makes an *edit* unsavable. The edit surface validates
 * through this — never a gate of its own: the form-owning step rules (token:
 * name, symbol, supply, slug, imported token; dao: budget format) plus the
 * form-level publish issues. The create-time wizard plan (schedule, unlocks)
 * is deliberately not consulted — a record's own terms are what a save must
 * keep.
 */
export function editIssues(wizard: WizardState, form: FormState): string[] {
  const issues = [
    ...wizardStepIssues(wizard, form, "token"),
    ...wizardStepIssues(wizard, form, "dao"),
  ];
  for (const issue of publishIssues(form, null)) {
    if (issue.severity === "error") {
      issues.push(`${issue.field}: ${issue.message}`);
    }
  }
  return issues;
}

/** True when the edit surface's save may proceed. */
export function canSaveEdit(wizard: WizardState, form: FormState): boolean {
  return editIssues(wizard, form).length === 0;
}

/**
 * The concrete window a publish will write, with the sale type's schedule
 * built for it — the last thing the contract checks before accepting the
 * parameters, so the dialog validates against the real thing.
 */
export function validationWindowFor(
  wizard: WizardState,
  window: { startBlock: number; endBlock: number; claimBlock: number } | null,
): ValidationWindow | null {
  if (!window) return null;
  const startBlock = BigInt(window.startBlock);
  const endBlock = BigInt(window.endBlock);
  const claimBlock = BigInt(window.claimBlock);
  return {
    startBlock,
    endBlock,
    claimBlock,
    steps: scheduleFor(SALE_PLANS[wizard.saleKind].shape, startBlock, endBlock),
  };
}

// ---------------------------------------------------------------------------
// The two seams: form state → published input
// ---------------------------------------------------------------------------

/**
 * The ladder the form starts from: MetaDAO's default package (cliff, then
 * 2x/4x/8x/16x/32x), the same numbers `CreateLaunchDialog` has always seeded.
 */
export function defaultVesting(): VestingConfig {
  return {
    cliffBlocks: 3_110_400,
    tranches: DEFAULT_PERFORMANCE_TRANCHES.map((tranche) => ({ ...tranche })),
    twapWindow: null,
  };
}

/** Structural equality — did anyone actually change the ladder? */
export function isDefaultVesting(
  vesting: VestingConfig | null | undefined,
): boolean {
  if (!vesting) return false;
  const fallback = defaultVesting();
  return (
    vesting.cliffBlocks === fallback.cliffBlocks &&
    vesting.twapWindow === fallback.twapWindow &&
    vesting.tranches.length === fallback.tranches.length &&
    vesting.tranches.every(
      (tranche, index) =>
        tranche.multiple === fallback.tranches[index].multiple &&
        tranche.percent === fallback.tranches[index].percent,
    )
  );
}

/**
 * Whether the performance ladder belongs on the published record.
 *
 * An *untouched* default is not published: the wizard's unlock choice is the
 * release schedule now, and silently attaching a second one is exactly the
 * kind of term an investor never saw. A ladder the record already carried, or
 * one the founder edited in Advanced, always publishes — an explicit edit is
 * the advanced-passthrough rule.
 */
export function publishableVesting(form: FormState): VestingConfig | undefined {
  if (!form.vesting || validateVesting(form.vesting).length > 0) {
    return undefined;
  }
  if (
    !form.vestingPresent &&
    !form.vestingDirty &&
    isDefaultVesting(form.vesting)
  ) {
    return undefined;
  }
  return form.vesting;
}

/**
 * The mapping today's form submits with, unchanged — this is what the edit
 * dialog calls, and the parity test compares the wizard against.
 */
export function buildLegacyInput(form: FormState): CreateLaunchInput {
  return {
    asAgent: form.asAgent,
    id: form.id.trim(),
    name: form.name.trim(),
    pitch: form.pitch.trim(),
    longPitch: form.longPitch.trim() || undefined,
    ipList: form.ipList
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    updateCadence: form.updateCadence.trim() || undefined,
    stage: "draft" as LaunchStage,
    chainId: form.chainId.trim(),
    currency: form.currency.trim(),
    floorPrice: form.floorPrice.trim(),
    tickSpacing: form.tickSpacing.trim(),
    requiredRaised: form.requiredRaised.trim(),
    auction: form.auction.trim(),
    token: form.tokenMode === "import" ? form.importAddress.trim() : "",
    treasury: form.treasury.trim(),
    admission: form.admission,
    channels: form.channels,
    allocation: form.allocation,
    vesting: publishableVesting(form),
    tokenPlan:
      form.tokenMode === "mint"
        ? {
            mode: "mint",
            name: form.tokenName.trim() || deriveTokenName(form.name),
            symbol: form.symbol.trim(),
            supply: form.supply.trim(),
          }
        : undefined,
    ...(form.startBlock !== null &&
    form.endBlock !== null &&
    form.claimBlock !== null
      ? {
          startBlock: form.startBlock,
          endBlock: form.endBlock,
          claimBlock: form.claimBlock,
        }
      : {}),
    ...(form.unlocks ? { unlocks: form.unlocks } : {}),
    ...(form.daoAtGraduation !== null
      ? { daoAtGraduation: form.daoAtGraduation }
      : {}),
  };
}

/**
 * What the wizard publishes: the legacy mapping with the wizard's decisions
 * written over it.
 *
 * - `id` falls back to the name's slug, so the founder never types one.
 * - `budget` is whatever the share or the Advanced drawer last wrote (same
 *   state — this line just states where it comes from).
 * - `unlocks` replaces the always-on default price ladder unless Advanced
 *   customized that ladder (`vesting` from the legacy mapping), which is the
 *   advanced-passthrough rule: an explicit edit beats the preset.
 * - the block window comes from the calendar conversion, or from the raw
 *   blocks typed in Advanced when all three are set.
 */
export function wizardToCreateInput(
  form: FormState,
  wizard: WizardState,
  options: {
    plan: SaleBlockPlan | null;
    rawBlocks?: {
      startBlock: number;
      endBlock: number;
      claimBlock: number;
    } | null;
    stage?: LaunchStage;
  },
): CreateLaunchInput {
  const legacy = buildLegacyInput(form);
  const raw = options.rawBlocks ?? null;
  const plan = options.plan;
  const unlocks = encodeUnlockPlan(
    unlockPlanFromWizard(wizard, form.allocation),
  );
  const id = effectiveLaunchId(form);
  return {
    ...legacy,
    id,
    name: form.name.trim(),
    stage: options.stage ?? legacy.stage,
    tokenPlan:
      form.tokenMode === "mint"
        ? {
            mode: "mint",
            name: form.tokenName.trim() || deriveTokenName(form.name),
            symbol: form.symbol.trim() || deriveSymbol(form.name),
            // `form.supply` is the tranche — what the record has always
            // stored; the wizard's "Total supply" field converts on the way in
            // (`trancheFromTotal`), so nothing converts twice.
            supply: form.supply.trim(),
          }
        : undefined,
    ...(raw
      ? {
          startBlock: raw.startBlock,
          endBlock: raw.endBlock,
          claimBlock: raw.claimBlock,
        }
      : plan
        ? {
            startBlock: plan.startBlock,
            endBlock: plan.endBlock,
            claimBlock: plan.claimBlock,
          }
        : {}),
    ...(unlocks ? { unlocks } : {}),
    daoAtGraduation: wizard.formDao,
    legalWrapper: wizard.legalWrapper,
  };
}

/** All three raw blocks set, or none — a half-typed window is not a window. */
export function parseRawBlocks(raw: {
  startBlock: string;
  endBlock: string;
  claimBlock: string;
}):
  | { startBlock: number; endBlock: number; claimBlock: number }
  | null
  | "incomplete" {
  const values = [
    raw.startBlock.trim(),
    raw.endBlock.trim(),
    raw.claimBlock.trim(),
  ];
  if (values.every((value) => value === "")) return null;
  if (!values.every((value) => /^\d+$/.test(value))) return "incomplete";
  const [startBlock, endBlock, claimBlock] = values.map(Number);
  if (!(startBlock < endBlock) || !(claimBlock >= endBlock))
    return "incomplete";
  return { startBlock, endBlock, claimBlock };
}

/** The window the wizard would write right now, or null when it cannot. */
export function planForWizard(
  wizard: WizardState,
  blockTime: {
    /** `null` when the chain could not be read — then there is no window. */
    head: number | null;
    secondsPerBlock: number;
    source: "measured" | "default";
  },
  now: number = nowSeconds(),
): SaleBlockPlan | null {
  if (blockTime.head === null) return null;
  const endAtSeconds =
    wizard.durationKey === "custom"
      ? endSecondsFromDateInput(wizard.endDate, now)
      : null;
  const durationSeconds = durationSecondsFor(wizard.durationKey);
  if (wizard.durationKey === "custom") {
    if (endAtSeconds === null) return null;
    return planSaleBlocks({
      head: blockTime.head,
      nowSeconds: now,
      secondsPerBlock: blockTime.secondsPerBlock,
      source: blockTime.source,
      endAtSeconds,
    });
  }
  if (durationSeconds === null) return null;
  return planSaleBlocks({
    head: blockTime.head,
    nowSeconds: now,
    secondsPerBlock: blockTime.secondsPerBlock,
    source: blockTime.source,
    durationSeconds,
  });
}

/** The duration presets as the dialog shows them, labels included. */
export const DURATION_CHOICES = SALE_DURATIONS;
