/**
 * The quick sale setup: a raise target and a sale length, with every other
 * choice defaulted (standard supply split, milestone unlocks, DAO at
 * graduation, no monthly budget). Founders who want more press "Customize".
 *
 * Alias-free on purpose: `quick-sale.test.mjs` drives it under `node --test`.
 */

import { atomicToPrice } from "./sale-plans.ts";
import { MILESTONE_TEMPLATES, milestonesFromTemplate } from "./unlock-plans.ts";
import {
  patchForRaiseTarget,
  type MilestoneRow,
  type SalePatch,
} from "./wizard.ts";

/**
 * Where an ETH sale starts. There is no dollar anchor for ETH (no oracle), so
 * this is only a starting point the founder edits: 0.000004 ETH a token.
 */
export const ETH_DEFAULT_PRICE = "0.000004";
/** And a cent a token in USDC: what the wizard has always started from. */
export const USDC_DEFAULT_PRICE = "0.01";

/** A raw Q96 floor (or anything unreadable) → the plain price box's text. */
export function q96ToPlainPrice(value: string, currencyDecimals = 6): string {
  try {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    return atomicToPrice(BigInt(trimmed), currencyDecimals);
  } catch {
    return "";
  }
}

/** A sensible first raise target in whole units of the sale currency. */
export function defaultRaiseTarget(currencyKind: string): string {
  return currencyKind === "eth" ? "120" : "300000";
}

/** The milestone rows the quick path starts with (the product-project plan). */
export function defaultMilestoneRows(): MilestoneRow[] {
  const template =
    MILESTONE_TEMPLATES.find((entry) => entry.key === "product") ??
    MILESTONE_TEMPLATES[0];
  return milestonesFromTemplate(template).map((row) => ({
    claim: row.claim,
    label: row.label,
    percent: row.percent,
  }));
}

export interface QuickSaleDefaults {
  raiseTarget: string;
  /** The floor, tick spacing and threshold the target implies; null if unreadable. */
  money: SalePatch | null;
  milestones: MilestoneRow[];
}

/** Everything the quick path derives before the founder types anything. */
export function quickSaleDefaults(
  currency: { kind: string; decimals: number },
  supply: string,
): QuickSaleDefaults {
  const raiseTarget = defaultRaiseTarget(currency.kind);
  return {
    raiseTarget,
    money: patchForRaiseTarget(
      raiseTarget,
      "graduating-auction",
      supply,
      currency.decimals,
    ),
    milestones: defaultMilestoneRows(),
  };
}

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** The choices the quick path made for the founder, as label/value rows. */
export function quickDefaultRows(input: {
  tokenName: string;
  symbol: string;
  /** Percent of supply put up for sale. */
  saleShare: number;
  /** Total supply as typed (commas and spaces allowed). */
  totalSupply: string;
  milestoneLabels: readonly string[];
  formDao: boolean;
}): Array<{ label: string; value: string }> {
  const supply = Number(input.totalSupply.replace(/[,_\s]/g, ""));
  const labels = input.milestoneLabels.map((l) => l.trim()).filter(Boolean);
  return [
    {
      label: "Token",
      value: `${input.tokenName.trim()} (${input.symbol.trim().toUpperCase()})`,
    },
    {
      label: "Tokens for sale",
      value:
        Number.isFinite(supply) && supply > 0
          ? `${input.saleShare}% of ${compact.format(supply)}`
          : `${input.saleShare}% of the supply`,
    },
    {
      label: "Your own tokens unlock",
      value: labels.length > 0 ? labels.join(", ") : "On a schedule",
    },
    {
      label: "If the target is met",
      value: input.formDao ? "It becomes a DAO" : "No DAO",
    },
  ];
}
