/**
 * Markets: what each project's Shares are trading at.
 *
 * It lists projects whose raise succeeded (their Shares can be bought and sold), with the last traded price, how far it
 * moved over the last day, how much was traded, and a small chart. Every figure is a price somebody actually got; a
 * project that has not traded says so instead of showing zeros, and projects without figures always sit below the ones
 * with them. The page links each project to its track record, because what a project has delivered is the thing worth
 * knowing before buying its Shares.
 */

import { Link } from "@tanstack/react-router";
import { ArrowLeft, LineChart } from "lucide-react";
import { useMemo, useState } from "react";

import { graduatedLaunches } from "@/features/feed/lib/launch-filters";
import { cn } from "@/shared/lib/cn";
import { PageHeader } from "@/shared/ui/PageHeader";
import { QueryError, errorMessage } from "@/shared/ui/query-error";

import { priceIndexerUrl } from "../chain";
import {
  BOARD_SORTS,
  type BoardSort,
  boardStats,
  formatBoardPrice,
  formatChange,
  formatVolume,
  sortBoard,
} from "../lib/market-board";
import { saleCurrencyFor } from "../lib/sale-currency";
import type { Launch } from "../models";
import { useLaunches } from "../use-launches";
import { useMarketBoard } from "../use-market";
import { UnauditedNotice } from "./UnauditedNotice";

/** A line through the closing prices, drawn at whatever width the cell gives it. */
function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <span aria-hidden className="block h-8 w-24" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 96;
      const y = 28 - ((p - min) / span) * 24;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="h-8 w-24"
      preserveAspectRatio="none"
      role="img"
      viewBox="0 0 96 32"
    >
      <title>Price over the last day</title>
      <path
        d={path}
        fill="none"
        stroke={up ? "rgb(5 150 105)" : "rgb(220 38 38)"}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function symbolOf(launch: Launch): string {
  const currency = saleCurrencyFor(
    launch.record.currency,
    launch.record.chainId,
  );
  return currency.kind === "custom" ? "USDC" : currency.symbol;
}

export function MarketsPage() {
  const { data, isLoading, error, refetch } = useLaunches();
  const [sort, setSort] = useState<BoardSort>("volume");
  const serviceConfigured = priceIndexerUrl() !== null;

  const graduated = useMemo(() => graduatedLaunches(data ?? []), [data]);
  const board = useMarketBoard(graduated);
  const now = Math.floor(Date.now() / 1000);

  const rows = graduated.map((launch, index) => {
    const result = board[index];
    return {
      launch,
      loading: result?.isLoading ?? false,
      failed: result?.isError ?? false,
      stats: result?.data ? boardStats(result.data, now) : null,
      createdAt: launch.record.createdAt,
    };
  });
  const sorted = sortBoard(rows, sort);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <Link
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
        to="/launchpad"
      >
        <ArrowLeft className="h-4 w-4" /> Launches
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <LineChart className="h-5 w-5" /> Markets
          </span>
        }
        description="What each project's Shares are trading at. Every figure is a price someone actually got."
      />
      <UnauditedNotice chainId={graduated[0]?.record.chainId} />

      {isLoading ? (
        <p className="text-sm text-black/60 dark:text-white/60">Loading…</p>
      ) : error ? (
        <QueryError
          description="The list of projects did not load."
          error={error}
          message={errorMessage(error)}
          onRetry={() => void refetch()}
          testId="markets-error"
          title="Couldn't load the markets"
        />
      ) : graduated.length === 0 ? (
        <p
          className="rounded-xl border border-black/10 p-6 text-sm text-black/70 dark:border-white/10 dark:text-white/70"
          data-testid="markets-empty"
        >
          Nothing is on the market yet. A project appears here once its raise
          has succeeded and its Shares can be bought and sold.{" "}
          <Link className="font-medium underline" to="/launchpad">
            See what is raising now
          </Link>
          .
        </p>
      ) : (
        <>
          {!serviceConfigured ? (
            <p
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              data-testid="markets-no-service"
              role="note"
            >
              Prices are not available here yet: this app is not connected to a
              price service. The projects are listed, without prices.
            </p>
          ) : null}
          <div className="flex items-center gap-2 text-sm">
            <label
              className="text-black/60 dark:text-white/60"
              htmlFor="markets-sort"
            >
              Sort by
            </label>
            <select
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              data-testid="markets-sort"
              id="markets-sort"
              onChange={(event) => setSort(event.target.value as BoardSort)}
              value={sort}
            >
              {BOARD_SORTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <ul className="divide-y divide-black/10 rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/10">
            {sorted.map((row) => {
              const { launch, stats } = row;
              const symbol = symbolOf(launch);
              const up = (stats?.change24h ?? 0) >= 0;
              return (
                <li
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                  data-testid="market-row"
                  key={`${launch.record.author}:${launch.record.id}`}
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <Link
                      className="block truncate font-semibold hover:underline"
                      data-testid="market-name"
                      params={{ launchId: launch.record.id }}
                      search={{
                        author: launch.record.author,
                        action: undefined,
                      }}
                      to="/launchpad/$launchId"
                    >
                      {launch.record.name}
                    </Link>
                    <Link
                      className="text-xs text-black/60 hover:underline dark:text-white/60"
                      data-testid="market-record"
                      params={{ launchId: launch.record.id }}
                      search={{
                        author: launch.record.author,
                        action: undefined,
                        tab: "record",
                      }}
                      to="/launchpad/$launchId"
                    >
                      Track record
                    </Link>
                  </div>
                  {stats ? (
                    <>
                      <Sparkline points={stats.points} up={up} />
                      <div className="w-28 text-right">
                        <p
                          className="text-sm font-semibold tabular-nums"
                          data-testid="market-price"
                        >
                          {formatBoardPrice(stats.price)}{" "}
                          <span className="text-xs font-normal text-black/60 dark:text-white/60">
                            {symbol}
                          </span>
                        </p>
                        <p
                          className={cn(
                            "text-xs font-medium tabular-nums",
                            stats.change24h === null
                              ? "text-black/60 dark:text-white/60"
                              : up
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-red-700 dark:text-red-400",
                          )}
                          data-testid="market-change"
                        >
                          {formatChange(stats.change24h)} today
                        </p>
                      </div>
                      <p
                        className="w-28 text-right text-xs text-black/60 tabular-nums dark:text-white/60"
                        data-testid="market-volume"
                      >
                        {formatVolume(stats.volume24h)} {symbol} traded today
                      </p>
                    </>
                  ) : (
                    <p
                      className="text-sm text-black/60 dark:text-white/60"
                      data-testid="market-untraded"
                    >
                      {row.loading
                        ? "Loading…"
                        : row.failed
                          ? "Could not read prices"
                          : serviceConfigured
                            ? "Not traded yet"
                            : "No price service"}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
