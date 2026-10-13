import { useQueries, useQuery } from "@tanstack/react-query";

import {
  ethCall,
  getRpcEndpoint,
  priceIndexerUrl,
  recordSaleCurrency,
} from "./chain";
import { decodeWord, encodeCall0 } from "./lib/work";
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
 * The pool that trades `token` (a project's Shares) against `currency`, once it has traded; null before. Asks the price
 * service at `base`.
 */
export async function fetchMarketPool(
  base: string,
  token: string,
  currency: string,
): Promise<IndexedPool | null> {
  const url = poolsUrl(base, token);
  if (!url) return null;
  const pool = pickPool(parsePools(await getJson(url)), token, currency);
  return pool && pool.swaps > 0 ? pool : null;
}

/** The traded prices of a launch's Shares in `pool`, one width of candle, oldest first. */
export async function fetchMarketCandles(
  base: string,
  launch: MarketLaunch,
  pool: IndexedPool,
  interval: number,
  limit: number,
): Promise<MarketCandle[]> {
  const token = launch.record.token;
  const url = candlesUrl(base, pool.id, interval, limit);
  if (!url || token === null) return [];
  return marketCandles(
    parseCandles(await getJson(url)),
    sharesAreToken0(pool, token),
    recordSaleCurrency(launch.record).decimals,
  );
}

/**
 * The last two days of hourly traded prices for each launch, in the order given: an empty list for a launch that has
 * not traded, and `undefined` data while it loads or when the price service could not be reached. Used by the market
 * board, which needs every project's figures at once so it can sort them.
 */
export function useMarketBoard(launches: readonly MarketLaunch[]) {
  const base = priceIndexerUrl();
  return useQueries({
    queries: launches.map((launch) => {
      const { token, currency } = launch.record;
      const usable =
        base !== null &&
        token !== null &&
        currency !== null &&
        ADDRESS.test(token) &&
        ADDRESS.test(currency);
      return {
        queryKey: ["launchpad", "market-board", base, token, currency],
        enabled: usable,
        queryFn: async (): Promise<MarketCandle[]> => {
          const pool = await fetchMarketPool(
            base as string,
            token as string,
            currency as string,
          );
          return pool
            ? fetchMarketCandles(base as string, launch, pool, 3600, 48)
            : [];
        },
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
      };
    }),
  });
}

/**
 * How many Shares there are in each launch's DAO (the Shares' own total supply), in the order given. `undefined` data
 * while it loads or when the chain could not be read: the board then shows no market value, never a guess.
 */
export function useSharesSupply(
  launches: readonly MarketLaunch[],
  /** Which launches to read, by position: only projects that have traded need a market value. */
  wanted: readonly boolean[],
) {
  const rpc = getRpcEndpoint();
  return useQueries({
    queries: launches.map((launch, index) => {
      const token = launch.record.token;
      const usable =
        wanted[index] === true &&
        rpc !== "" &&
        token !== null &&
        ADDRESS.test(token);
      return {
        queryKey: ["launchpad", "shares-supply", rpc, token],
        enabled: usable,
        queryFn: async (): Promise<bigint> =>
          decodeWord(
            await ethCall(rpc, token as string, encodeCall0("totalSupply()")),
          ),
        staleTime: 300_000,
        refetchOnWindowFocus: false,
        retry: 1,
      };
    }),
  });
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
    queryFn: () =>
      fetchMarketPool(base as string, token as string, currency as string),
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
    queryFn: () =>
      fetchMarketCandles(
        base as string,
        launch,
        pool as IndexedPool,
        interval,
        limit,
      ),
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
