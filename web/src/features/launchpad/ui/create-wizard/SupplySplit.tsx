/**
 * Who gets the tokens: one aligned row per share, a bar that shows the whole
 * split at a glance, and a total that says plainly whether it adds up.
 *
 * Presentational — the dialog owns the allocation. Test ids are the contract
 * the e2e suite and the edit surface already use (`launch-allocation*`).
 */

import {
  ALLOCATION_LABELS,
  minimumLiquidityPercent,
  totalAllocation,
  type SupplyAllocation,
} from "../../lib/allocation";
import { Button } from "@/shared/ui/button";

/** One colour per share, shared by the bar and the row dots. */
const SHARE_COLORS: Record<keyof SupplyAllocation, string> = {
  sale: "#35cc82",
  team: "#a77bff",
  treasury: "#5b8def",
  liquidity: "#3cc7d9",
  milestones: "#f0b44c",
  community: "#ec6aa6",
};

const compactNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** `1000000000` and "1,000,000,000" both read as a billion; junk reads as nothing. */
function parseSupply(text: string): number | null {
  const value = Number(text.replace(/[,_\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface SupplySplitProps {
  allocation: SupplyAllocation;
  onChange(key: keyof SupplyAllocation, value: number): void;
  onReset(): void;
  /** Why the split cannot be published, or null when it adds up. */
  issue: string | null;
  /** The total supply as typed, so each share can show its token count. */
  totalSupply: string;
}

export function SupplySplit({
  allocation,
  onChange,
  onReset,
  issue,
  totalSupply,
}: SupplySplitProps) {
  const total = totalAllocation(allocation);
  const supply = parseSupply(totalSupply);
  const balanced = total === 100;
  const barBase = Math.max(total, 100);
  const minLiquidity = minimumLiquidityPercent({
    salePercent: allocation.sale,
    raiseShareBps: 2000,
  });
  const thin = minLiquidity !== null && allocation.liquidity < minLiquidity;

  return (
    <section
      aria-labelledby="launch-allocation-title"
      className="rounded-xl border border-border/60 bg-foreground/[0.04] p-4"
      data-testid="launch-allocation"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold" id="launch-allocation-title">
            Who gets the tokens
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The part that is not sold decides what the sold part is worth.
          </p>
        </div>
        <Button
          data-testid="launch-allocation-standard"
          onClick={onReset}
          size="sm"
          type="button"
          variant="outline"
        >
          Standard split
        </Button>
      </div>

      <div
        aria-hidden
        className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-foreground/10"
        data-testid="launch-allocation-bar"
      >
        {ALLOCATION_LABELS.map(({ key }) =>
          allocation[key] > 0 ? (
            <span
              className="h-full first:rounded-l-full last:rounded-r-full"
              key={key}
              style={{
                backgroundColor: SHARE_COLORS[key],
                width: `${(allocation[key] / barBase) * 100}%`,
              }}
            />
          ) : null,
        )}
      </div>

      <ul className="mt-3 divide-y divide-border/60">
        {ALLOCATION_LABELS.map(({ key, label, hint }) => (
          <li
            className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-4 py-2.5"
            key={key}
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                aria-hidden
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: SHARE_COLORS[key] }}
              />
              <div className="min-w-0">
                <label
                  className="block text-sm font-semibold"
                  htmlFor={`launch-allocation-${key}`}
                >
                  {label}
                </label>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            </div>
            <div className="text-right">
              <div className="relative">
                <input
                  className="h-9 w-full rounded-lg border border-input bg-background/60 pl-3 pr-7 text-right text-sm font-semibold tabular-nums focus:border-ring focus:outline-none"
                  data-testid={`launch-allocation-${key}`}
                  id={`launch-allocation-${key}`}
                  inputMode="numeric"
                  max={100}
                  min={0}
                  onChange={(event) => {
                    const next =
                      Number(event.target.value.replace(/\D/g, "")) || 0;
                    onChange(key, next);
                  }}
                  type="number"
                  value={allocation[key]}
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                >
                  %
                </span>
              </div>
              {supply !== null ? (
                <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground">
                  {compactNumber.format((supply * allocation[key]) / 100)}{" "}
                  tokens
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div
        className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-3"
        data-testid="launch-allocation-total"
      >
        <span className="text-sm font-bold">Total</span>
        <span
          aria-live="polite"
          className={`rounded-full px-3 py-1 text-sm font-bold tabular-nums ${
            balanced
              ? "bg-primary/15 text-primary-ink"
              : "bg-red-500/15 text-red-600 dark:text-red-300"
          }`}
        >
          {total}%{balanced ? " ✓" : ""}
        </span>
      </div>

      {issue ? (
        <p
          className="mt-2 text-xs text-red-600 dark:text-red-400"
          data-testid="launch-allocation-issue"
        >
          {issue}
        </p>
      ) : null}
      {minLiquidity !== null ? (
        <p
          className={`mt-2 text-xs ${
            thin
              ? "text-amber-700 dark:text-amber-300"
              : "text-muted-foreground"
          }`}
          data-testid="launch-lp-minimum"
        >
          {thin
            ? `This seeds the pool with under ${minLiquidity}% of supply — it covers less than 20% of the floor raise, so day-one liquidity will be thin.`
            : `A pool at ${allocation.liquidity}% of supply covers ${Math.round(
                (allocation.liquidity / allocation.sale) * 20,
              )}% of the floor raise at the floor price.`}
        </p>
      ) : null}
    </section>
  );
}
