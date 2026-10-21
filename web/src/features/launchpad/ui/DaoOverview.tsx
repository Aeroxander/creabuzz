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
import { isContributorProject } from "../lib/funding";
import { openWorkAreas } from "../lib/ways-to-help";
import type { Launch } from "../models";
import { useDaoHoldings } from "../use-dao-holdings";
import { useConnectedWallet } from "../use-connected-wallet";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { usePaymentRuns, useSpendingSummary } from "../use-spending";
import { useChallengeLock } from "../use-challenge-lock";
import { useWork } from "../use-work";
import { decisionStage } from "./DecisionCard";
import { bondsOf, decisionTitler } from "./decision-title";
import { Figure } from "./Figure";
import { ProjectDeliveryOverview } from "./ProjectDeliveryOverview";
import { ProjectProgressFeed } from "@/features/feed/ui/ProjectProgressFeed";
import { MilestoneProgressCard } from "./MilestoneProgressCard";
import { SpendingCard } from "./SpendingCard";
import { MoneyInCard, MoneyInUnavailable } from "./MoneyInCard";
import { useMoneyIn } from "../use-money-in";
import { useWalletLabels } from "../use-wallet-labels";

export type OverviewTarget =
  | "decisions"
  | "work"
  | "discussion"
  | "record"
  | "milestones"
  | "agents"
  | "treasury";

export function DaoOverview({
  launch,
  dao,
  onOpen,
  children,
}: {
  launch: Launch;
  dao: string;
  /** Open a tab; with a claim, the Work tab opens on that claim. */
  onOpen: (
    tab: OverviewTarget,
    claim?: { id: string; mandate: string },
  ) => void;
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

  const runs = usePaymentRuns(dao, spending);
  const moneyIn = useMoneyIn({
    dao,
    currency: launch.record.currency || null,
    auction: launch.record.auction,
    shares: context.data?.shares ?? null,
    budgets: work.data?.mandates.map((m) => m.address),
  });
  const payerLabel = useWalletLabels(
    moneyIn.data?.paidIn.map((p) => p.from) ?? [],
  );

  const chainId = Number(launch.record.chainId ?? "") || 0;
  const challengeLock = useChallengeLock(dao);
  // The chain's own time, in which every deadline here is given.
  const clock =
    challengeLock.data?.now ??
    decisions.data?.chainTime ??
    work.data?.chainTime ??
    0;
  // Most urgent first: what closes soonest comes before what can wait.
  const ranked = rankAttention(
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
  // How many work areas take submissions now (their words are on the Work tab, under Ways to help).
  const openAreas = work.data ? openWorkAreas(work.data, []).length : 0;
  // A contributor project always says how to take part, even before a work area is open.
  const contributor = isContributorProject(launch.record);
  // What this person can do now, and their own work waiting on someone else, said apart.
  const items = ranked.filter((item) => item.actor !== "others");
  const waiting = ranked.filter((item) => item.actor === "others");
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
  const loading =
    decisions.isLoading || work.isLoading || challengeLock.isLoading;
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
                      onClick={() => onOpen(item.tab, item.claim)}
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
            {waiting.length > 0 ? (
              <div className="mt-3" data-testid="dao-waiting-others">
                <h4 className="text-xs font-semibold text-muted-foreground">
                  Waiting on someone else
                </h4>
                <ul className="mt-1 divide-y divide-border/60">
                  {waiting.map((item) => (
                    <li
                      className="flex items-start justify-between gap-3 py-2"
                      data-testid="dao-waiting"
                      key={item.key}
                    >
                      <span className="text-sm">
                        {item.text}
                        {item.due !== undefined && item.due > clock ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {`Changes ${deadline(item.due)}.`}
                          </span>
                        ) : null}
                      </span>
                      <Button
                        onClick={() => onOpen(item.tab, item.claim)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {item.action}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </Card>
      {openAreas > 0 || (contributor && work.data) ? (
        <Card
          className="flex flex-wrap items-center justify-between gap-3 p-4"
          data-testid="dao-ways-to-help"
        >
          <span className="text-sm">
            <span className="font-semibold">Ways to help:</span>{" "}
            {openAreas === 0
              ? "No work area is open for submissions yet. Ask the team what would help."
              : openAreas === 1
                ? "1 work area is open for submissions. You need no Shares to submit work."
                : `${openAreas} work areas are open for submissions. You need no Shares to submit work.`}
          </span>
          <span className="flex flex-wrap gap-2">
            {openAreas > 0 ? (
              <Button
                data-testid="dao-ways-to-help-open"
                onClick={() => onOpen("work")}
                size="sm"
                type="button"
              >
                See ways to help
              </Button>
            ) : null}
            <Button
              data-testid="dao-join-discussion"
              onClick={() => onOpen("discussion")}
              size="sm"
              type="button"
              variant="outline"
            >
              Join the discussion
            </Button>
          </span>
        </Card>
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
      <ProjectDeliveryOverview launch={launch} dao={dao} onOpen={onOpen} />
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

      <MilestoneProgressCard
        dao={dao}
        launch={launch}
        onOpen={() => onOpen("milestones")}
      />

      {spending && sale ? (
        <SpendingCard
          chainId={chainId}
          decimals={sale.decimals}
          labelOf={labelOf}
          onOpenDecisions={() => onOpen("decisions")}
          runs={runs.isError && !runs.data ? null : runs.data}
          summary={spending}
          symbol={symbol}
        />
      ) : null}
      {moneyIn.data && sale ? (
        <MoneyInCard
          chainId={chainId}
          decimals={sale.decimals}
          labelOf={payerLabel}
          pledge={launch.record.revenuePledge}
          summary={moneyIn.data}
          symbol={symbol}
        />
      ) : moneyIn.isError && sale ? (
        <MoneyInUnavailable onRetry={() => void moneyIn.refetch()} />
      ) : null}

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

      <ProjectProgressFeed project={launch} compact />
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
