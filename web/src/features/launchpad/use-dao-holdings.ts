import { useQuery } from "@tanstack/react-query";

import { erc20BalanceOf, ethCall, getRpcEndpoint } from "./chain";
import { decodeU256 } from "./chain";

/** `totalSupply()` */
const TOTAL_SUPPLY = "0x18160ddd";

export interface DaoHoldings {
  /** What the DAO's treasury holds in the project's currency, or null when it could not be read (never a guess of zero). */
  treasury: bigint | null;
  /** Every Share that exists. */
  sharesInAll: bigint | null;
  /** The Shares the connected wallet holds. */
  yourShares: bigint | null;
}

/** The three numbers an overview opens with, each read straight from the chain. */
export function useDaoHoldings(input: {
  dao: string;
  currency: string | null;
  shares: string | null;
  wallet: string | null;
}) {
  const { dao, currency, shares, wallet } = input;
  return useQuery({
    queryKey: ["launchpad", "work", dao, "holdings", currency, shares, wallet],
    enabled: shares !== null,
    queryFn: async (): Promise<DaoHoldings> => {
      const endpoint = getRpcEndpoint();
      const [treasury, sharesInAll, yourShares] = await Promise.all([
        currency
          ? erc20BalanceOf(endpoint, currency, dao)
          : Promise.resolve(null),
        ethCall(endpoint, shares as string, TOTAL_SUPPLY).then(
          decodeU256,
          () => null,
        ),
        wallet
          ? erc20BalanceOf(endpoint, shares as string, wallet)
          : Promise.resolve(null),
      ]);
      return { treasury, sharesInAll, yourShares };
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
