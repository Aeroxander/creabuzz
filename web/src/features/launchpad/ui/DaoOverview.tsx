/**
 * A DAO's front page: what is going on, what is waiting for you, and what it holds.
 *
 * The question a person asks of an organization they belong to is not "what were the raise's terms" but "what is
 * happening, does it need me, and what do I do about it", in that order. This page answers them from the chain (the
 * decisions and the work the other tabs read, and the three balances that matter) and sends each answer to the tab
 * where it is acted on. The raise this project came from is still here, folded away underneath.
 */

import type { ReactNode } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { recordSaleCurrency } from "../chain";
import { challengeAttention } from "../lib/challenge-attention";
import { deadline } from "../lib/challenge-copy";
import {
  attentionItems,
  overviewCounts,
  rankAttention,
  summaryLine,
} from "../lib/dao-overview";
import { formatUnits } from "../lib/dao-actions";
import type { Launch } from "../models";
import { useDaoHoldings } from "../use-dao-holdings";
import { useConnectedWallet } from "../use-connected-wallet";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { useSpendingSummary } from "../use-spending";
import { useChallengeLock } from "../use-challenge-lock";
import { useWork } from "../use-work";
import { decisionStage } from "./DecisionCard";
import { bondsOf, decisionTitler } from "./decision-title";
import { Figure } from "./Figure";
import { MilestoneProgressCard } from "./MilestoneProgressCard";
import { SpendingCard } from "./SpendingCard";

export type OverviewTarget = "decisions" | "work" | "record" | "milestones";

export function DaoOverview({
  launch,
  dao,
  onOpen,
  children,
}: {
  launch: Launch;
  dao: string;
  onOpen: (tab: OverviewTarget) => void;
  /** The raise this project came from, shown folded under "About the raise". */
  children: ReactNode;
}) {
  const wallet = useConnectedWallet().address;
  const decisions = useDecisions(dao, wallet);
  const work = useWork(dao, wallet);
  const context = useDecisionContext(dao);
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const holdings = useDaoHoldings({
    dao,
    currency: launch.record.currency ?? null,
    shares: context.data?.shares ?? null,
    wallet,
  });
  const titleOf = decisionTitler({
    launch,
    dao,
    factory: context.data?.factory,
    mandates: work.data?.mandates.map((m) => m.address),
    bonds: bondsOf(work.data),
    projectToken: context.data?.shares,
  });

  const { spending, labelOf } = useSpendingSummary({
    dao,
    currency: launch.record.currency,
    decisions: decisions.data,
    work: work.data,
    factory: context.data?.factory,
  });

  const challengeLock = useChallengeLock(dao);
  // The chain's own time, in which every deadline here is given.
  const clock =
    challengeLock.data?.now ??
    decisions.data?.chainTime ??
    work.data?.chainTime ??
    0;
  // Most urgent first: what closes soonest comes before what can wait.
  const items = rankAttention(
    [
      ...attentionItems({
        decisions: decisions.data,
        work: work.data,
        wallet,
        titleOf,
        labelOf,
      }),
      ...(challengeLock.data && wallet
        ? challengeAttention(challengeLock.data, wallet)
        : []),
    ],
    clock,
  );
  // A read that failed with nothing earlier to show: an empty list would be a guess, not an answer.
  const unread = [decisions, work, challengeLock].some(
    (q) => q.isError && q.data === undefined,
  );
  const retryReads = () => {
    for (const q of [decisions, work, challengeLock]) {
      if (q.isError) void q.refetch();
    }
  };
  const counts = overviewCounts(decisions.data, work.data);
  const loading = decisions.isLoading || work.isLoading;
  const money = holdings.data?.treasury;
  const symbol = sale?.kind === "custom" ? "USDC" : (sale?.symbol ?? "");
  const shares = (value: bigint | null | undefined) =>
    value === null || value === undefined ? "—" : formatUnits(value, 18, 0);
  const share =
    holdings.data?.sharesInAll &&
    holdings.data.sharesInAll > 0n &&
    holdings.data.yourShares !== null
      ? `${((Number(holdings.data.yourShares) / Number(holdings.data.sharesInAll)) * 100).toFixed(1)}% of the DAO`
      : undefined;
  const latest = (decisions.data?.decisions ?? []).slice(0, 3);

  return (
    <div className="flex flex-col gap-4" data-testid="dao-overview">
      <Card className="p-4">
        <h2 className="text-base font-bold">Where things stand</h2>
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="dao-summary"
        >
          {loading
            ? "Reading from the network…"
            : decisions.isError && work.isError
              ? "Couldn't read this project from the network. Try again in a moment."
              : summaryLine(counts)}
        </p>
      </Card>

      {!loading &&
      work.data &&
      counts.workBudgets === 0 &&
      counts.openDecisions === 0 ? (
        <Card className="p-4" data-testid="dao-start-work">
          <h3 className="text-sm font-semibold">
            {(counts.carriedOut ?? 0) > 0
              ? "Set up a work budget"
              : "Set up the first work budget"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A work budget sets aside Shares (and money, if you want) for people
            to earn by doing work. Holders vote on it, then anyone can file a
            claim for what they did and reviewers check it.
          </p>
          <Button
            className="mt-2"
            onClick={() => onOpen("decisions")}
            size="sm"
            type="button"
          >
            Put a work budget to a vote
          </Button>
        </Card>
      ) : null}

      <Card className="p-4" data-testid="dao-needs-you">
        <h3 className="text-sm font-semibold">Needs you</h3>
        {wallet === null ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your wallet in the Decisions or Work tab to see what is
            waiting for you.
          </p>
        ) : (
          <>
            {unread ? (
              <div
                className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                data-testid="dao-unread"
                role="status"
              >
                <span>
                  {items.length === 0
                    ? "Could not read this project just now, so we cannot say whether anything is waiting for you."
                    : "Could not read all of this project just now, so this list may be missing something."}
                </span>
                <Button
                  data-testid="dao-unread-retry"
                  onClick={retryReads}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {items.length === 0 ? (
              unread ? null : (
                <p
                  className="mt-1 text-sm text-muted-foreground"
                  data-testid="dao-nothing"
                >
                  {loading ? "Checking…" : "Nothing is waiting for you."}
                </p>
              )
            ) : (
              <ul className="mt-2 divide-y divide-border/60">
                {items.map((item) => (
                  <li
                    className="flex items-start justify-between gap-3 py-2"
                    data-testid="dao-attention"
                    key={item.key}
                  >
                    <span className="text-sm">
                      {item.text}
                      {item.why || item.ifIgnored || item.due ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.due !== undefined && item.due > clock
                            ? `Closes ${deadline(item.due)}. `
                            : ""}
                          {item.why ? `${item.why} ` : ""}
                          {item.ifIgnored ?? ""}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      onClick={() => onOpen(item.tab)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {item.action}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <MilestoneProgressCard
        dao={dao}
        launch={launch}
        onOpen={() => onOpen("milestones")}
      />

      {spending && sale ? (
        <SpendingCard
          decimals={sale.decimals}
          labelOf={labelOf}
          onOpenDecisions={() => onOpen("decisions")}
          summary={spending}
          symbol={symbol}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Figure
          label="In the treasury"
          note={
            !launch.record.currency
              ? "This project did not raise money"
              : money === null
                ? "Could not be read"
                : "What the DAO holds now. Money already set aside for work is not counted."
          }
          testId="dao-figure-treasury"
          value={
            money === null || money === undefined || !sale
              ? "—"
              : `${formatUnits(money, sale.decimals)} ${symbol}`.trim()
          }
        />
        <Figure
          label="Shares in all"
          testId="dao-figure-shares"
          value={shares(holdings.data?.sharesInAll)}
        />
        <Figure
          label="You hold"
          note={share}
          testId="dao-figure-yours"
          value={
            wallet === null
              ? "—"
              : `${shares(holdings.data?.yourShares)} Shares`
          }
        />
      </div>

      <Card
        className="flex flex-wrap items-center justify-between gap-3 p-4"
        data-testid="dao-record-link"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Track record</h3>
          <p className="text-sm text-muted-foreground">
            What this DAO has paid and to whom, and how much of its team's
            tokens have unlocked so far. Anyone can check it.
          </p>
        </div>
        <Button
          onClick={() => onOpen("record")}
          size="sm"
          type="button"
          variant="outline"
        >
          Open the track record
        </Button>
      </Card>

      {latest.length > 0 ? (
        <Card className="p-4" data-testid="dao-latest">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Latest decisions</h3>
            <Button
              onClick={() => onOpen("decisions")}
              size="sm"
              type="button"
              variant="ghost"
            >
              See all
            </Button>
          </div>
          <ul className="mt-2 divide-y divide-border/60">
            {latest.map((decision) => (
              <li
                className="flex items-baseline justify-between gap-3 py-2 text-sm"
                key={decision.id}
              >
                <span className="min-w-0 truncate">{titleOf(decision)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {
                    decisionStage(decision, decisions.data?.chainTime ?? 0)
                      .label
                  }
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <details
        className="rounded-xl border border-border/60 px-3 py-2"
        data-testid="dao-raise-details"
      >
        <summary className="cursor-pointer text-sm font-medium select-none">
          About the raise this project came from
        </summary>
        <div className="mt-3 flex flex-col gap-4">{children}</div>
      </details>
    </div>
  );
}
