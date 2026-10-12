import { recordSaleCurrency } from "../chain";
import { describeDecision } from "../lib/decision-describe";
import type { Decision } from "../lib/decisions";
import type { Launch } from "../models";

/**
 * What a decision is called on screen: its action in a sentence, without the full stop. Descriptions are only trusted
 * for calls aimed at the DAO's own contracts, so the factory and the work budgets are passed in.
 */
export function decisionTitler(input: {
  launch: Launch;
  dao: string;
  factory: string | undefined;
  mandates: string[] | undefined;
}): (decision: Decision) => string {
  const { launch, dao, factory, mandates } = input;
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const context = {
    dao,
    factory,
    mandates,
    currency: launch.record.currency ?? undefined,
    currencySymbol: sale?.kind === "custom" ? "USDC" : sale?.symbol,
    currencyDecimals: sale?.decimals,
  };
  return (decision) =>
    (decision.action
      ? describeDecision(decision.action, context).title
      : "a decision that did not say what it would do"
    ).replace(/\.$/, "");
}
