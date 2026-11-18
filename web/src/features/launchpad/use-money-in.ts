import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { keepIfSame } from "./keep-previous";
import { type MoneyIn, readMoneyIn } from "./lib/money-in";
import { recordChain } from "./use-work";

/**
 * Money that came into the DAO's treasury in its currency (`lib/money-in.ts`), read from the currency's own events.
 * `budgets` are the DAO's work budgets, so what they return is not counted as paid in; it waits for them. A lookup that
 * fails is an error the card says, never a figure.
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
    queryFn: (): Promise<MoneyIn> =>
      readMoneyIn(recordChain(getRpcEndpoint()), {
        dao,
        currency: currency as string,
        auction,
        shares,
        budgets: budgets ?? [],
      }),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
