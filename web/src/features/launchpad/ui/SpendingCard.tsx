/**
 * Where the treasury's money went: through work budgets that pay only against reviewed claims, or straight out by a vote.
 *
 * A DAO can do both, and a backer judging whether a team is accountable needs to see the split. This is the plain
 * reading of it: the words come from `spendingHeadline`, the figures from what the chain returned, and anything the page
 * could not read is said so rather than left out.
 */

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { formatAtomic } from "../lib/amounts";
import { type SpendingSummary, spendingHeadline } from "../lib/spending";

const MOST_SHOWN = 5;

export function SpendingCard({
  summary,
  symbol,
  decimals,
  labelOf,
  onOpenDecisions,
}: {
  /** How a wallet is written: the person's name with the short address, or just the address. */
  labelOf: (address: string) => string;
  summary: SpendingSummary;
  symbol: string;
  decimals: number;
  onOpenDecisions: () => void;
}) {
  const money = (units: bigint) =>
    `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${symbol}`.trim();
  const shown = summary.direct.slice(0, MOST_SHOWN);
  return (
    <Card className="p-4" data-testid="dao-spending">
      <h3 className="text-sm font-semibold">
        Where the treasury&apos;s money went
      </h3>
      <p className="mt-1 text-sm" data-testid="dao-spending-headline">
        {spendingHeadline(summary)}
      </p>
      <dl className="mt-3 grid gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Set aside for reviewed work</dt>
          <dd data-testid="dao-spending-reviewed">
            {money(summary.reviewedBudget)}
            {summary.reviewedBudget > 0n
              ? `, of which ${money(summary.reviewedPaid)} has been paid to claims the reviewers approved`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Paid out directly by a vote, with no reviewer
          </dt>
          <dd data-testid="dao-spending-direct">
            {money(summary.directTotal)}
            {summary.direct.length > 0
              ? ` in ${summary.direct.length} payment${summary.direct.length === 1 ? "" : "s"}`
              : ""}
          </dd>
        </div>
      </dl>
      {shown.length > 0 ? (
        <ul
          className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground"
          data-testid="dao-spending-payments"
        >
          {shown.map((payment) => (
            <li key={`${payment.decisionId}-${payment.position}`}>
              {money(payment.amount)} to {labelOf(payment.to)}
            </li>
          ))}
          {summary.direct.length > shown.length ? (
            <li>and {summary.direct.length - shown.length} more</li>
          ) : null}
        </ul>
      ) : null}
      {summary.unread > 0 ? (
        <p
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="dao-spending-unread"
        >
          {summary.unread} other decision{summary.unread === 1 ? "" : "s"} that
          ran could have moved money, and this page cannot read{" "}
          {summary.unread === 1 ? "it" : "them"}. Open the decisions to see what
          they did.
        </p>
      ) : null}
      {!summary.workRead ? (
        <p
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="dao-spending-work-unread"
        >
          The work budgets have not been read, so the reviewed-work figure above
          may be missing rather than zero.
        </p>
      ) : null}
      {summary.workTruncated ? (
        <p
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="dao-spending-work-cut"
        >
          This DAO has more work budgets or claims than this page reads, so the
          reviewed-work figures may be low.
        </p>
      ) : null}
      {summary.otherCurrencyBudgets > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {summary.otherCurrencyBudgets} work budget
          {summary.otherCurrencyBudgets === 1 ? " is" : "s are"} in another
          currency and not added to the figures above.
        </p>
      ) : null}
      {summary.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Counted from the newest {summary.decisionsRead} of{" "}
          {summary.decisionsTotal} decisions.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        A work budget pays out only against claims the reviewers approve. A
        direct payment is an ordinary decision the holders voted for; nothing
        checks what the money is spent on.
      </p>
      <Button
        className="mt-2"
        onClick={onOpenDecisions}
        size="sm"
        type="button"
        variant="outline"
      >
        See the decisions
      </Button>
    </Card>
  );
}
