import { useQuery } from "@tanstack/react-query";

import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";

import { getRpcEndpoint } from "./chain";
import {
  defaultChainPreset,
  localUsdcAddress,
  weeklyRounds,
} from "./chain-config";
import {
  fundingPhase,
  readFundingContract,
  readFundingTerms,
} from "./lib/funding-terms";
import { exitSalesState, readExitSales } from "./lib/matched-exit";
import { readRounds } from "./lib/weekly-rounds";
import { decodeAddress, decodeWord, encodeCall0, SIGNATURES } from "./lib/work";
import { encodeAllowance, encodeBalanceOf } from "./lib/work-bounty";
import type { RoundsWallet } from "./use-weekly-rounds";
import { endpointChain } from "./use-work";

/** Where every query about funding the project lives, so a step sent from one re-reads them all. */
export const FUNDING_QUERY = ["launchpad", "funding"] as const;

/**
 * Funding a project (D133): its funding terms as its summoner's funding-terms contract holds them, whether its weekly
 * rounds are on (sales happen in them), its latest funding round, and the connected wallet's money for a bid.
 */
export function useFunding(dao: string, wallet: string | null) {
  const chainId = defaultChainPreset().chainId;
  const rounds = weeklyRounds(chainId);
  const usdc = usdcAddress(chainId, localUsdcAddress());
  const query = useQuery({
    queryKey: [...FUNDING_QUERY, dao, wallet, rounds],
    enabled: rounds !== null && usdc !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      const at = rounds as string;
      const currency = usdc as string;
      const policy = decodeAddress(
        await chain.call(dao, encodeCall0(SIGNATURES.policy)),
      );
      const factory = decodeAddress(
        await chain.call(policy, encodeCall0(SIGNATURES.factory)),
      );
      const contract = await readFundingContract(chain, factory);
      // A DAO whose summoner predates funding terms has none to show.
      if (!contract) return null;
      const [terms, now, sharesHex] = await Promise.all([
        readFundingTerms(chain, contract, dao),
        chain.now(),
        chain.call(dao, encodeCall0("shares()")),
      ]);
      const exchange = await readExitSales(chain, decodeAddress(sharesHex));
      const roundsOn =
        exchange !== null && exitSalesState(exchange, at, now).phase === "on";
      const funding = await readRounds(chain, at, dao, wallet, now, "funding");
      let side: RoundsWallet | null = null;
      if (wallet) {
        const [usdcBalance, usdcAllowance] = await Promise.all([
          chain.call(currency, encodeBalanceOf(wallet)).then(decodeWord),
          chain.call(currency, encodeAllowance(wallet, at)).then(decodeWord),
        ]);
        side = { free: 0n, sharesAllowance: 0n, usdcBalance, usdcAllowance };
      }
      return {
        contract,
        rounds: at,
        usdc: currency,
        now,
        terms,
        phase: fundingPhase(terms, now),
        roundsOn,
        funding,
        wallet: side,
      };
    },
  });
  return { rounds, query };
}
