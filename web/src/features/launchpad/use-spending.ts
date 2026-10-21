import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getRpcEndpoint } from "./chain";
import { readExecutions } from "./lib/payment-history";
import { type SpendingSummary, summariseSpending } from "./lib/spending";
import type { DecisionsSnapshot } from "./lib/decisions";
import type { WorkSnapshot } from "./lib/work-read";
import { useWalletLabels } from "./use-wallet-labels";
import { recordChain } from "./use-work";

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

/**
 * When, and in which transaction, each direct payment's decision ran (`lib/payment-history.ts`), so the spending card can
 * link every payment to the chain. Nothing is read until there are payments to date.
 */
export function usePaymentRuns(dao: string, spending: SpendingSummary | null) {
  const ids = [...new Set(spending?.direct.map((p) => p.decisionId) ?? [])];
  return useQuery({
    queryKey: ["launchpad", "work", dao, "payment-runs", ids],
    enabled: ids.length > 0,
    queryFn: () => readExecutions(recordChain(getRpcEndpoint()), dao, ids),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
