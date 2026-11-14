import { Gift, HandCoins, Landmark, PiggyBank } from "lucide-react";

import { Card } from "@/shared/ui/card";
import { formatAtomic } from "../lib/amounts";
import { paceLine, type Runway } from "../lib/runway";
import { Figure } from "./Figure";

/**
 * Money on hand (N4): what the treasury holds, what work budgets hold for work not paid yet, what was paid out, money
 * others put behind the project's work areas, and an estimate of how many months it lasts. Each figure is kept apart so
 * nothing is counted twice; money paid to people leaving is their own part and is not counted as paid out.
 */
export function RunwayCard({
  figures,
  outsideWaiting,
  symbol,
  decimals,
}: {
  figures: Runway;
  /** Money others put behind this project's work areas that is still waiting (N1); 0 for none. */
  outsideWaiting: bigint;
  symbol: string;
  decimals: number;
}) {
  const money = (units: bigint | null) =>
    units === null
      ? "Could not be read"
      : `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${symbol}`.trim();
  return (
    <Card className="p-4" data-testid="dao-runway">
      <h3 className="text-sm font-semibold">Money on hand</h3>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure
          icon={Landmark}
          label="Held by the project"
          testId="runway-free"
          value={money(figures.free)}
        />
        <Figure
          icon={PiggyBank}
          label="Set aside for work"
          note="Not paid yet"
          testId="runway-set-aside"
          value={money(figures.setAside)}
        />
        <Figure
          icon={HandCoins}
          label="Paid out"
          note={`${money(figures.spentRecent)} in the last three months`}
          testId="runway-spent"
          value={money(figures.spentTotal)}
        />
        {outsideWaiting > 0n ? (
          <Figure
            icon={Gift}
            label="Behind its work areas"
            note="Put there by others"
            testId="runway-outside"
            value={money(outsideWaiting)}
          />
        ) : null}
      </div>
      <p className="mt-2 text-sm" data-testid="runway-pace">
        {paceLine(figures.pace)}
      </p>
      {figures.incomplete ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="runway-incomplete"
          role="status"
        >
          Some payments could not be read or dated, so the paid-out figures may
          be low.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        Money paid to people leaving is their own part and is not counted as
        paid out.
      </p>
    </Card>
  );
}

/** Nothing held, set aside, paid or put behind work: a contributor project with no money says nothing about money. */
export function runwayIsEmpty(
  figures: Runway,
  outsideWaiting: bigint,
): boolean {
  return (
    figures.free === 0n &&
    figures.setAside === 0n &&
    figures.spentTotal === 0n &&
    outsideWaiting === 0n &&
    !figures.incomplete
  );
}
