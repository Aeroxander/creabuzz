import { useQuery } from "@tanstack/react-query";

import { decodeU256, ethCall, ethGetLogs, getRpcEndpoint } from "./chain";
import { keepIfSame } from "./keep-previous";
import {
  type MoneyIn,
  SELECTOR_FUNDS_RECIPIENT,
  summariseMoneyIn,
  TRANSFER_TOPIC,
  transfersInFromLogs,
} from "./lib/money-in";

const LOCK_GUARD = "0x36bc529d";
const addressOf = (hex: string) =>
  `0x${decodeU256(hex).toString(16).padStart(40, "0")}`;

/**
 * Money that came into the DAO's treasury in its currency (`lib/money-in.ts`), read from the currency's own events.
 * `budgets` are the DAO's work budgets, so what they return is not counted as paid in.
 */
export function useMoneyIn(input: {
  dao: string;
  currency: string | null;
  auction: string | null;
  shares: string | null;
  budgets: readonly string[] | undefined;
}) {
  const { dao, currency, auction, shares, budgets } = input;
  return useQuery({
    queryKey: [
      "launchpad",
      "work",
      dao,
      "money-in",
      currency,
      auction,
      shares,
      budgets,
    ],
    enabled: currency !== null && budgets !== undefined,
    placeholderData: keepIfSame(2, dao),
    queryFn: async (): Promise<MoneyIn> => {
      const endpoint = getRpcEndpoint();
      const [logs, executor, lock] = await Promise.all([
        ethGetLogs(endpoint, {
          address: currency as string,
          topics: [
            TRANSFER_TOPIC,
            null,
            `0x${dao.slice(2).toLowerCase().padStart(64, "0")}`,
          ],
          fromBlock: "0x0",
          toBlock: "latest",
        }),
        auction
          ? ethCall(endpoint, auction, SELECTOR_FUNDS_RECIPIENT).then(
              addressOf,
              () => null,
            )
          : Promise.resolve(null),
        shares
          ? ethCall(endpoint, shares, LOCK_GUARD).then(addressOf, () => null)
          : Promise.resolve(null),
      ]);
      return summariseMoneyIn({
        transfers: transfersInFromLogs(logs, dao),
        raise: [auction, executor].filter((a): a is string => a !== null),
        budgets: budgets ?? [],
        locks: lock && !/^0x0{40}$/.test(lock) ? [lock] : [],
      });
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
