import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import {
  courtAddress,
  createToken,
  defaultChainPreset,
  remixBonds,
} from "./chain-config";
import { readRemixBond } from "./lib/remix-bond";
import { decodeAddress, decodeWord, encodeCall0 } from "./lib/work";
import { encodeAllowance, encodeBalanceOf } from "./lib/work-bounty";
import { endpointChain } from "./use-work";

/** Where every query about remix bonds lives, so a step sent from one re-reads them all. */
export const REMIX_BOND_QUERY = ["launchpad", "remix-bond"] as const;

/**
 * A remix's latest bond to its parent (N12), the court's fee for a case, and the connected wallet's CREATE and fee money,
 * when this build names the bond contract.
 */
export function useRemixBond(coordinate: string, wallet: string | null) {
  const chainId = defaultChainPreset().chainId;
  const contract = remixBonds(chainId);
  const court = courtAddress(chainId);
  const create = createToken(chainId);
  const query = useQuery({
    queryKey: [...REMIX_BOND_QUERY, contract, coordinate, wallet],
    enabled: contract !== null && court !== null && create !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      const [bond, now, fee, feeToken] = await Promise.all([
        readRemixBond(chain, contract as string, coordinate),
        chain.now(),
        chain
          .call(court as string, encodeCall0("arbitrationCost()"))
          .then(decodeWord),
        chain
          .call(court as string, encodeCall0("feeToken()"))
          .then(decodeAddress),
      ]);
      const mine = wallet
        ? await Promise.all([
            chain
              .call(create as string, encodeBalanceOf(wallet))
              .then(decodeWord),
            chain
              .call(
                create as string,
                encodeAllowance(wallet, contract as string),
              )
              .then(decodeWord),
            chain
              .call(feeToken, encodeAllowance(wallet, contract as string))
              .then(decodeWord),
          ])
        : null;
      return {
        bond,
        now,
        fee,
        feeToken,
        contract: contract as string,
        create: create as string,
        wallet: mine
          ? { create: mine[0], createAllowance: mine[1], feeAllowance: mine[2] }
          : null,
      };
    },
  });
  return { contract, query };
}
