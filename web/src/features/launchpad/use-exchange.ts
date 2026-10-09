import { useQuery } from "@tanstack/react-query";

import {
  ethCall,
  exchangeAddresses,
  getRpcEndpoint,
  recordSaleCurrency,
} from "./chain";
import { readMilestoneLock } from "./lib/milestone-lock";
import {
  findMarketPool,
  type MarketPool,
  readPoolPrice,
} from "./lib/market-read";
import { decodeWord } from "./lib/work";
import type { Launch } from "./models";
import { endpointChain } from "./use-work";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const word = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");

/** Everything the trade card needs about one project's market: where it trades, what at, and what this wallet holds. */
export function useExchange(
  launch: Launch,
  dao: string,
  wallet: string | null,
) {
  const exchange = exchangeAddresses(launch.record.chainId);
  const { token, currency } = launch.record;
  const usable =
    exchange !== null &&
    token !== null &&
    currency !== null &&
    ADDRESS.test(token) &&
    ADDRESS.test(currency);
  const decimals = recordSaleCurrency(launch.record).decimals;

  const pool = useQuery({
    queryKey: [
      "launchpad",
      "work",
      dao,
      "market-pool",
      exchange?.amm,
      token,
      currency,
    ],
    enabled: usable,
    queryFn: (): Promise<MarketPool | null> =>
      findMarketPool(endpointChain(getRpcEndpoint()), {
        amm: (exchange as NonNullable<typeof exchange>).amm,
        sharesToken: token as string,
        currency: currency as string,
      }),
    staleTime: 15_000,
  });
  const price = useQuery({
    queryKey: ["launchpad", "work", dao, "market-price", pool.data?.id],
    enabled: usable && Boolean(pool.data),
    queryFn: () =>
      readPoolPrice(endpointChain(getRpcEndpoint()), {
        amm: (exchange as NonNullable<typeof exchange>).amm,
        pool: pool.data as MarketPool,
        currencyDecimals: decimals,
      }),
    staleTime: 5_000,
    refetchInterval: (q) => (q.state.status === "error" ? false : 10_000),
  });
  const holdings = useQuery({
    queryKey: [
      "launchpad",
      "work",
      dao,
      "holdings",
      wallet,
      token,
      currency,
      exchange?.amm,
    ],
    enabled: usable && wallet !== null,
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
      const balanceOf = (t: string) =>
        ethCall(endpoint, t, `0x70a08231${word(wallet as string)}`);
      const [shares, money, allowShares, allowMoney, lock] = await Promise.all([
        balanceOf(token as string),
        balanceOf(currency as string),
        ethCall(
          endpoint,
          token as string,
          `0xdd62ed3e${word(wallet as string)}${word((exchange as NonNullable<typeof exchange>).amm)}`,
        ),
        ethCall(
          endpoint,
          currency as string,
          `0xdd62ed3e${word(wallet as string)}${word((exchange as NonNullable<typeof exchange>).amm)}`,
        ),
        readMilestoneLock(endpointChain(endpoint), dao, wallet as string).catch(
          () => null,
        ),
      ]);
      return {
        shares: decodeWord(shares),
        money: decodeWord(money),
        allowShares: decodeWord(allowShares),
        allowMoney: decodeWord(allowMoney),
        locked: lock?.locked ?? 0n,
      };
    },
    staleTime: 3_000,
    refetchInterval: (q) => (q.state.status === "error" ? false : 10_000),
  });

  return { exchange, usable, decimals, pool, price, holdings };
}
