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
  fundingContractOrThrow,
  readFundingContract,
  readFundingTerms,
} from "@creaton/core/launchpad/fundingTerms.ts";
import { exitExchangeState, readExchangeIfAny } from "./lib/exit-exchange";
import {
  type OpenClaim,
  readOpenClaims,
  readRounds,
} from "@creaton/core/launchpad/weeklyRounds.ts";
import {
  decodeAddress,
  decodeWord,
  encodeCall0,
  SIGNATURES,
} from "@creaton/core/launchpad/work.ts";
import {
  encodeAllowance,
  encodeBalanceOf,
} from "@creaton/core/launchpad/workBounty.ts";
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
      // A DAO whose summoner genuinely has no funding terms has none to show; a
      // read that did not complete throws, so the card says it could not read
      // rather than hiding the section as though the contract were old.
      const contract = fundingContractOrThrow(
        await readFundingContract(chain, factory),
      );
      if (!contract) return null;
      const [terms, now, sharesHex] = await Promise.all([
        readFundingTerms(chain, contract, dao),
        chain.now(),
        chain.call(dao, encodeCall0("shares()")),
      ]);
      // The DAO's own Shares, kept: a funding round sells either these (they vote)
      // or the DAO's loot (they do not), and the round card names which by
      // comparing the round's token with this address.
      const daoShares = decodeAddress(sharesHex);
      const exchange = await readExchangeIfAny(chain, daoShares);
      const roundsOn =
        exchange !== null &&
        exitExchangeState(exchange, at, now).phase === "on";
      const funding = await readRounds(chain, at, dao, wallet, now, "funding");
      // Earlier funding rounds where this wallet still has something to collect; the latest is shown on its own.
      const latest = funding.round?.id ?? null;
      const claims: OpenClaim[] = wallet
        ? (await readOpenClaims(chain, at, dao, wallet, now)).filter(
            (c) => c.funding && c.id !== latest,
          )
        : [];
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
        shares: daoShares,
        usdc: currency,
        now,
        terms,
        phase: fundingPhase(terms, now),
        roundsOn,
        funding,
        claims,
        wallet: side,
      };
    },
  });
  return { rounds, query };
}
