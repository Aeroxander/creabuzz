import { useQuery } from "@tanstack/react-query";

import { priceIndexerUrl, recordSaleCurrency } from "./chain";
import {
  candlesUrl,
  type IndexedPool,
  indexerIntervalFor,
  type MarketCandle,
  marketCandles,
  parseCandles,
  parsePools,
  pickPool,
  poolsUrl,
  sharesAreToken0,
} from "./lib/market-feed";

/** The part of a launch the market price needs; the app's `Launch` satisfies it. */
export interface MarketLaunch {
  record: {
    token: string | null;
    currency: string | null;
    chainId: string | null;
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`The price service answered ${response.status}.`);
  }
  return response.json();
}

/**
 * The pool that trades this launch's Shares against its sale currency, once it has traded. Null when no price service
 * is configured, the launch has no Shares or currency address, or nothing has traded: callers then show what they
 * showed before (recorded bids, or the sale's floor), labelled as that.
 */
export function useMarketPool(launch: MarketLaunch) {
  const base = priceIndexerUrl();
  const { token, currency } = launch.record;
  const usable =
    base !== null &&
    token !== null &&
    currency !== null &&
    ADDRESS.test(token) &&
    ADDRESS.test(currency);
  return useQuery({
    queryKey: ["launchpad", "market-pool", base, token, currency],
    enabled: usable,
    queryFn: async (): Promise<IndexedPool | null> => {
      const url = poolsUrl(base as string, token as string);
      if (!url) return null;
      const pool = pickPool(
        parsePools(await getJson(url)),
        token as string,
        currency as string,
      );
      return pool && pool.swaps > 0 ? pool : null;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * The traded prices of this launch's Shares, in whole currency per Share, as the price service keeps them (one width
 * of candle, oldest first). Empty until a pool has traded.
 */
export function useMarketCandles(
  launch: MarketLaunch,
  timeframeSeconds: number,
  limit = 500,
) {
  const base = priceIndexerUrl();
  const pool = useMarketPool(launch).data ?? null;
  const interval = indexerIntervalFor(timeframeSeconds);
  const token = launch.record.token;
  return useQuery({
    queryKey: ["launchpad", "market-candles", base, pool?.id, interval, limit],
    enabled: base !== null && pool !== null && token !== null,
    queryFn: async (): Promise<MarketCandle[]> => {
      const url = candlesUrl(
        base as string,
        (pool as IndexedPool).id,
        interval,
        limit,
      );
      if (!url) return [];
      const decimals = recordSaleCurrency(launch.record).decimals;
      return marketCandles(
        parseCandles(await getJson(url)),
        sharesAreToken0(pool as IndexedPool, token as string),
        decimals,
      );
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** What a `$TICKER` chip shows from the market: the last trade and the recent closes, or null before any trade. */
export function useMarketPrice(launch: MarketLaunch) {
  const candles = useMarketCandles(launch, 300, 12).data ?? [];
  const last = candles[candles.length - 1];
  if (!last) return null;
  return { latest: last.close, points: candles.map((c) => c.close) };
}
