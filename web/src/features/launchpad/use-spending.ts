import { useMemo } from "react";

import { type SpendingSummary, summariseSpending } from "./lib/spending";
import type { DecisionsSnapshot } from "./lib/decisions";
import type { WorkSnapshot } from "./lib/work-read";
import { useWalletLabels } from "./use-wallet-labels";

/**
 * Where a DAO's money went (`lib/spending.ts`) and how to write the wallets in it, from reads the page already holds.
 * Until both reads are in it says nothing (`null`) rather than something wrong.
 */
export function useSpendingSummary(input: {
  dao: string;
  /** The launch's sale currency: an ERC-20 address, or empty for the chain's own coin. */
  currency: string | null | undefined;
  decisions: DecisionsSnapshot | undefined;
  work: WorkSnapshot | undefined;
  factory: string | undefined;
}): {
  spending: SpendingSummary | null;
  labelOf: (address: string) => string;
  /** The wallets worth naming on this page, so other cards can add theirs to one lookup. */
  people: string[];
} {
  const { dao, currency, decisions, work, factory } = input;
  const spending = useMemo(
    () =>
      decisions && work
        ? summariseSpending({
            decisions: decisions.decisions,
            decisionsTotal: decisions.total,
            truncated: decisions.truncated,
            work,
            currency: currency || null,
            context: {
              dao,
              factory,
              mandates: work.mandates.map((m) => m.address),
            },
          })
        : null,
    [decisions, work, currency, dao, factory],
  );
  const people = useMemo(
    () => [
      ...(work?.mandates ?? []).flatMap((m) => [
        ...m.claims.map((c) => c.record.contributor),
        ...m.reviewers.map((r) => r.address),
        ...m.projects.map((p) => p.record.manager),
      ]),
      ...(decisions?.decisions.map((d) => d.proposer) ?? []),
      ...(spending?.direct.map((p) => p.to) ?? []),
    ],
    [work, decisions, spending],
  );
  return { spending, labelOf: useWalletLabels(people), people };
}
