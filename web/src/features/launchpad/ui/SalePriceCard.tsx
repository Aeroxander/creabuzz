/**
 * The price card on a launch page before its token trades.
 *
 * It used to chart the highest price each recorded bid said it would pay, which looks like a market and is not one: a
 * bid's limit is not a price anyone paid. Before trading, the honest picture is the sale itself: the floor it starts at,
 * and the price the auction clears at now (read from the chain). How much of the minimum raise is in is the raise bar
 * the page already shows.
 */

import { useQuery } from "@tanstack/react-query";

import { Card } from "@/shared/ui/card";

import { clearingPrice, getRpcEndpoint } from "../chain";
import { formatPrice, q96ToPrice } from "../lib/candles";
import { saleCurrencyFor } from "@creaton/core/launchpad/sale-currency.ts";
import type { Launch } from "../models";

export function SalePriceCard({ launch }: { launch: Launch }) {
  const { record } = launch;
  const currency = saleCurrencyFor(record.currency, record.chainId);
  const symbol = currency.kind === "custom" ? "USDC" : currency.symbol;
  const floor = q96ToPrice(record.floorPrice, currency.decimals);
  const endpoint = getRpcEndpoint();
  const clearing = useQuery({
    queryKey: ["launchpad", "clearing-price", record.auction, endpoint],
    queryFn: () => clearingPrice(endpoint, record.auction as string),
    enabled: Boolean(record.auction),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const current = q96ToPrice(
    clearing.data === null || clearing.data === undefined
      ? null
      : clearing.data.toString(),
    currency.decimals,
  );

  return (
    <Card className="p-4" data-testid="launch-sale-price">
      <h2 className="text-base font-bold">Sale price</h2>
      <p className="text-xs text-muted-foreground">
        This token is not trading yet. The sale sets its price: it starts at the
        floor and rises as demand comes in. Bids are not trades.
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm tabular-nums sm:grid-cols-2">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Floor price</dt>
          <dd className="font-bold" data-testid="launch-sale-floor">
            {floor !== null ? `${formatPrice(floor)} ${symbol}` : "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Clearing price now</dt>
          <dd className="font-bold" data-testid="launch-sale-clearing">
            {current !== null ? `${formatPrice(current)} ${symbol}` : "—"}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
