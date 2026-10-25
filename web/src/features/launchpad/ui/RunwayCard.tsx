import { Card } from "@/shared/ui/card";
import { formatAtomic } from "../lib/amounts";
import { paceLine, type Runway } from "../lib/runway";

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
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">In the treasury</dt>
        <dd data-testid="runway-free">{money(figures.free)}</dd>
        <dt className="text-muted-foreground">
          Set aside for work, not yet paid
        </dt>
        <dd data-testid="runway-set-aside">{money(figures.setAside)}</dd>
        <dt className="text-muted-foreground">Paid out</dt>
        <dd data-testid="runway-spent">
          {money(figures.spentTotal)}, of which {money(figures.spentRecent)} in
          the last three months
        </dd>
        {outsideWaiting > 0n ? (
          <>
            <dt className="text-muted-foreground">
              Put behind its work areas by others
            </dt>
            <dd data-testid="runway-outside">{money(outsideWaiting)}</dd>
          </>
        ) : null}
      </dl>
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
