import { useQuery } from "@tanstack/react-query";

import {
  decodeU256,
  ethCall,
  ethGetBalance,
  getRpcEndpoint,
  localUsdcAddress,
} from "./chain";
import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";
import type { MoneyHeld } from "./lib/send-money";

export const ACCOUNT_MONEY_QUERY = ["launchpad", "account-money"] as const;

/** The money an account holds on `chainId` that this app knows how to send (D141): USDC there, and ETH. */
export function useAccountMoney(
  address: string | null,
  chainId: number | null,
) {
  return useQuery({
    queryKey: [...ACCOUNT_MONEY_QUERY, chainId, address],
    enabled: address !== null && chainId !== null,
    queryFn: async (): Promise<MoneyHeld[]> => {
      const endpoint = getRpcEndpoint();
      const account = address as string;
      const usdc = usdcAddress(chainId, localUsdcAddress());
      const [eth, usdcBalance] = await Promise.all([
        ethGetBalance(endpoint, account),
        usdc
          ? ethCall(
              endpoint,
              usdc,
              `0x70a08231${account.slice(2).toLowerCase().padStart(64, "0")}`,
            ).then(decodeU256)
          : Promise.resolve(null),
      ]);
      return [
        ...(usdc && usdcBalance !== null
          ? [{ token: usdc, symbol: "USDC", decimals: 6, balance: usdcBalance }]
          : []),
        { token: null, symbol: "ETH", decimals: 18, balance: eth },
      ];
    },
    staleTime: 15_000,
    retry: 1,
  });
}
