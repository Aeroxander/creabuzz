/**
 * Money that came into the treasury (D78): the raise, what work budgets and the milestone lock sent back, and every
 * other payment in, by whom and when. Beside it, the team's revenue pledge, if it made one, with the reminder that the
 * contracts do not enforce it. The chain cannot say what a payment was for, so the card never calls one revenue.
 *
 * Each payment shows its day and its transaction, and the whole list opens in place, so a backer can check every one.
 * When where the raise came from could not be read, the card says it cannot tell instead of sorting the money wrong.
 */

import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { formatAtomic } from "../lib/amounts";
import { type MoneyIn, moneyInHeadline } from "../lib/money-in";
import { pledgeSentence, type RevenuePledge } from "../lib/revenue-pledge";
import { paidOn, TxLink } from "./TxLink";

const MOST_SHOWN = 5;

export function MoneyInCard({
  summary,
  pledge,
  symbol,
  decimals,
  labelOf,
  chainId,
}: {
  summary: MoneyIn;
  pledge: RevenuePledge | null;
  symbol: string;
  decimals: number;
  labelOf: (address: string) => string;
  chainId: number;
}) {
  const [all, setAll] = useState(false);
  const money = (units: bigint) =>
    `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${symbol}`.trim();
  const shown = all ? summary.paidIn : summary.paidIn.slice(0, MOST_SHOWN);
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
          {shown.map((payment) => (
            <li
              data-testid="dao-money-in-payment"
              key={`${payment.tx}:${payment.from}:${payment.amount}`}
            >
              {money(payment.amount)} from {labelOf(payment.from)}
              <span className="block text-xs text-muted-foreground">
                {paidOn(payment.at)} ·{" "}
                <TxLink chainId={chainId} tx={payment.tx} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.paidIn.length > MOST_SHOWN ? (
        <Button
          className="mt-1"
          data-testid="dao-money-in-all"
          onClick={() => setAll((open) => !open)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {all ? "Show fewer" : `Show all ${summary.paidIn.length} payments`}
        </Button>
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

/** Said instead of the card when the money could not be sorted: a lookup failed, so no figure is shown. */
export function MoneyInUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="p-4" data-testid="dao-money-in-unavailable">
      <h3 className="text-sm font-semibold">Money that came in</h3>
      <p className="mt-1 text-sm">
        Couldn&apos;t tell what came into the treasury just now: looking up
        where the raise and the bonds came from did not work, and without that
        the raise could look like extra payments. Nothing is shown until it can
        be read.
      </p>
      <Button
        className="mt-2"
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        Try again
      </Button>
    </Card>
  );
}
