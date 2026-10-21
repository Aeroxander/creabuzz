/**
 * Money that came into the treasury (D78): the raise, what work budgets and the milestone lock sent back, and every
 * other payment in, by whom and when. Beside it, the team's revenue pledge, if it made one, with the reminder that the
 * contracts do not enforce it. The chain cannot say what a payment was for, so the card never calls one revenue.
 */

import { Card } from "@/shared/ui/card";

import { formatAtomic } from "../lib/amounts";
import { type MoneyIn, moneyInHeadline } from "../lib/money-in";
import { pledgeSentence, type RevenuePledge } from "../lib/revenue-pledge";

const MOST_SHOWN = 5;

export function MoneyInCard({
  summary,
  pledge,
  symbol,
  decimals,
  labelOf,
}: {
  summary: MoneyIn;
  pledge: RevenuePledge | null;
  symbol: string;
  decimals: number;
  labelOf: (address: string) => string;
}) {
  const money = (units: bigint) =>
    `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${symbol}`.trim();
  return (
    <Card className="p-4" data-testid="dao-money-in">
      <h3 className="text-sm font-semibold">Money that came in</h3>
      <p className="mt-1 text-sm" data-testid="dao-money-in-headline">
        {moneyInHeadline(summary, money)}
      </p>
      {summary.paidIn.length > 0 ? (
        <ul
          className="mt-2 flex flex-col gap-1 text-sm"
          data-testid="dao-money-in-list"
        >
          {summary.paidIn.slice(0, MOST_SHOWN).map((payment) => (
            <li key={`${payment.tx}:${payment.from}`}>
              {money(payment.amount)} from {labelOf(payment.from)}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
        <dt>The raise</dt>
        <dd>{money(summary.raise)}</dd>
        {summary.fromBudgets > 0n ? (
          <>
            <dt>Back from work budgets</dt>
            <dd>{money(summary.fromBudgets)}</dd>
          </>
        ) : null}
        {summary.fromLocks > 0n ? (
          <>
            <dt>Bonds and deposits</dt>
            <dd>{money(summary.fromLocks)}</dd>
          </>
        ) : null}
      </dl>
      <p
        className="mt-2 text-xs text-muted-foreground"
        data-testid="dao-money-in-pledge"
      >
        {pledge
          ? pledgeSentence(pledge)
          : "The team has not pledged any of what the project earns to the treasury."}{" "}
        What is paid in stays in the treasury, where every holder can leave with
        their part of it.
      </p>
    </Card>
  );
}
