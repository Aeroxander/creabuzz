/**
 * The price chart on a launch page.
 *
 * Built from the prices bidders recorded on this relay — the highest price each
 * bid said it would pay — so it shows how demand has moved against the floor.
 * It is not a market feed and the card says so. Once a token trades, a pool feed
 * can replace the points without touching the chart.
 */

import { useMemo, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { Card } from "@/shared/ui/card";
import {
  atomicToWhole,
  bucketCandles,
  defaultTimeframe,
  q96ToPrice,
  TIMEFRAMES,
  type PricePoint,
  type TimeframeId,
} from "../lib/candles";
import { saleCurrencyFor } from "../lib/sale-currency";
import type { Launch } from "../models";
import { CandlestickChart, formatPrice } from "./CandlestickChart";

export function PriceChartCard({ launch }: { launch: Launch }) {
  const { record, bids } = launch;
  const currency = saleCurrencyFor(record.currency, record.chainId);
  const decimals = currency.decimals;
  const symbol = currency.kind === "custom" ? "USDC" : currency.symbol;

  const points = useMemo<PricePoint[]>(
    () =>
      bids.flatMap((bid) => {
        const price = q96ToPrice(bid.maxPrice, decimals);
        if (price === null) return [];
        return [
          {
            time: bid.createdAt,
            price,
            volume: atomicToWhole(bid.budget, decimals) ?? 0,
          },
        ];
      }),
    [bids, decimals],
  );
  const floor = q96ToPrice(record.floorPrice, decimals);

  const [chosen, setChosen] = useState<TimeframeId | null>(null);
  const timeframeId = chosen ?? defaultTimeframe(points);
  const timeframe =
    TIMEFRAMES.find((frame) => frame.id === timeframeId) ?? TIMEFRAMES[0];
  const candles = useMemo(
    () => bucketCandles(points, timeframe.seconds),
    [points, timeframe.seconds],
  );

  const first = candles[0];
  const last = candles[candles.length - 1];
  const change =
    first && last && first.open > 0
      ? ((last.close - first.open) / first.open) * 100
      : null;
  const high = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
  const low = candles.length ? Math.min(...candles.map((c) => c.low)) : null;

  return (
    <Card className="p-4" data-testid="launch-price-chart">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">Price</h2>
          <p className="text-xs text-muted-foreground">
            Highest price each recorded bid would pay — not market trades.
          </p>
        </div>
        <fieldset className="flex gap-1 rounded-lg bg-secondary/60 p-1">
          <legend className="sr-only">Chart timeframe</legend>
          {TIMEFRAMES.map((frame) => (
            <button
              aria-pressed={frame.id === timeframeId}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-bold transition-colors",
                frame.id === timeframeId
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={frame.id}
              onClick={() => setChosen(frame.id)}
              type="button"
            >
              {frame.label}
            </button>
          ))}
        </fieldset>
      </div>

      {candles.length === 0 ? (
        <div
          className="mt-4 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
          data-testid="launch-price-chart-empty"
        >
          No bids with a price yet. The chart fills in as bids are recorded
          {floor !== null
            ? ` — the floor is ${formatPrice(floor)} ${symbol}`
            : ""}
          .
        </div>
      ) : (
        <>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            <div>
              <dt className="inline text-muted-foreground">Last </dt>
              <dd className="inline font-bold">
                {formatPrice(last.close)} {symbol}
              </dd>
            </div>
            {change !== null ? (
              <div>
                <dt className="sr-only">Change</dt>
                <dd
                  className={cn(
                    "font-bold",
                    change >= 0 ? "text-primary-ink" : "text-[#f0617d]",
                  )}
                >
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(1)}%
                </dd>
              </div>
            ) : null}
            {high !== null && low !== null ? (
              <div className="text-muted-foreground">
                Range {formatPrice(low)}–{formatPrice(high)}
              </div>
            ) : null}
            <div className="text-muted-foreground">{points.length} bids</div>
          </dl>
          <div className="mt-2">
            <CandlestickChart
              bucketSeconds={timeframe.seconds}
              candles={candles}
              currency={symbol}
              label={`Candlestick chart of ${points.length} recorded bid prices for ${record.name}, last ${formatPrice(last.close)} ${symbol}`}
            />
          </div>
        </>
      )}
    </Card>
  );
}
