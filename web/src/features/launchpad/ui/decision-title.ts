import { recordSaleCurrency } from "../chain";
import { matchedExit, payoutsFactory } from "../chain-config";
import type { DescribeContext } from "../lib/dao-actions";
import { describeDecision } from "../lib/decision-describe";
import type { Decision } from "../lib/decisions";
import type { Launch } from "../models";
import type { WorkSnapshot } from "../lib/work-read";

/** Each work budget's bond (token, name, decimals), so a decision to take a bond can say its amount in words. */
export function bondsOf(
  work: WorkSnapshot | undefined,
): DescribeContext["bonds"] {
  if (!work) return undefined;
  return Object.fromEntries(
    work.mandates.flatMap((m) =>
      // A bond whose token did not say its decimals cannot put an amount in words: the vote then reads in base units.
      m.bond?.decimalsKnown
        ? [
            [
              m.address.toLowerCase(),
              {
                token: m.bond.token,
                symbol: m.bond.symbol,
                decimals: m.bond.decimals,
              },
            ],
          ]
        : [],
    ),
  );
}

/**
 * What a decision is called on screen: its action in a sentence, without the full stop. Descriptions are only trusted
 * for calls aimed at the DAO's own contracts, so the factory and the work budgets are passed in.
 */
export function decisionTitler(input: {
  launch: Launch;
  dao: string;
  factory: string | undefined;
  mandates: string[] | undefined;
  bonds?: DescribeContext["bonds"];
  /** The DAO's own Shares, so a bond paid in them reads as "the project's own token". */
  projectToken?: string;
  label?: DescribeContext["label"];
}): (decision: Decision) => string {
  const { launch, dao, factory, mandates, bonds, projectToken, label } = input;
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const context = {
    dao,
    factory,
    mandates,
    bonds,
    projectToken,
    matchedExit: matchedExit(launch.record.chainId ?? null) ?? undefined,
    payoutsFactory: payoutsFactory(launch.record.chainId ?? null) ?? undefined,
    label,
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
