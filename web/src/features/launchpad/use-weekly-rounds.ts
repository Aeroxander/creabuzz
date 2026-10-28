import { useQuery } from "@tanstack/react-query";

import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";

import { getRpcEndpoint } from "./chain";
import {
  defaultChainPreset,
  localUsdcAddress,
  weeklyRounds,
} from "./chain-config";
import { exitSalesState, readExitSales } from "./lib/matched-exit";
import { fetchRagequitPosition } from "./lib/ragequit-position";
import {
  type OpenClaim,
  readOpenClaims,
  readRounds,
} from "./lib/weekly-rounds";
import { decodeWord } from "./lib/work";
import { encodeAllowance, encodeBalanceOf } from "./lib/work-bounty";
import { endpointChain } from "./use-work";

/** Where every query about weekly rounds lives, so a step sent from one re-reads them all. */
export const WEEKLY_ROUNDS_QUERY = ["launchpad", "weekly-rounds"] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

/** The connected wallet's side: what it can offer and what it can pay. */
export interface RoundsWallet {
  /** Shares it holds, less what a lock still holds back. */
  free: bigint;
  sharesAllowance: bigint;
  usdcBalance: bigint;
  usdcAllowance: bigint;
}

/**
 * Weekly rounds for one DAO (D131), when this build names the rounds contract on its network: whether the DAO's Shares
 * name it as their exchange, the latest round with the price steps people chose, and the connected wallet's side.
 */
export function useWeeklyRounds(dao: string, wallet: string | null) {
  const chainId = defaultChainPreset().chainId;
  const contract = weeklyRounds(chainId);
  const usdc = usdcAddress(chainId, localUsdcAddress());
  const query = useQuery({
    queryKey: [...WEEKLY_ROUNDS_QUERY, dao, wallet, contract],
    enabled: contract !== null && usdc !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
      const chain = endpointChain(endpoint);
      const at = contract as string;
      const currency = usdc as string;
      const [position, now] = await Promise.all([
        fetchRagequitPosition(endpoint, dao, wallet ?? ZERO, [currency]),
        chain.now(),
      ]);
      const shares = position.sharesToken;
      const exchange = await readExitSales(chain, shares);
      // Shares made before exchanges existed have nothing to show.
      if (!exchange) return null;
      const state = exitSalesState(exchange, at, now);
      // Read whatever the exchange: a round already running stays collectable after a vote turns rounds off.
      const rounds = await readRounds(chain, at, dao, wallet, now);
      // Earlier holders' rounds where this wallet still has something to collect; the latest is shown on its own.
      const latest = rounds.round?.id ?? null;
      const claims: OpenClaim[] = wallet
        ? (await readOpenClaims(chain, at, dao, wallet, now)).filter(
            (c) => !c.funding && c.id !== latest,
          )
        : [];
      let side: RoundsWallet | null = null;
      if (wallet) {
        const [sharesAllowance, usdcBalance, usdcAllowance] = await Promise.all(
          [
            chain.call(shares, encodeAllowance(wallet, at)),
            chain.call(currency, encodeBalanceOf(wallet)),
            chain.call(currency, encodeAllowance(wallet, at)),
          ],
        );
        side = {
          free: position.sharesBurnable,
          sharesAllowance: decodeWord(sharesAllowance),
          usdcBalance: decodeWord(usdcBalance),
          usdcAllowance: decodeWord(usdcAllowance),
        };
      }
      return {
        chainId,
        contract: at,
        usdc: currency,
        shares,
        now,
        state,
        rounds,
        claims,
        wallet: side,
      };
    },
  });
  return { chainId, contract, query };
}
