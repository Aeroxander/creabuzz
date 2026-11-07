import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import {
  contributorKit,
  courtAddress,
  createToken,
  defaultChainPreset,
  remixBonds,
} from "./chain-config";
import { kitLaunchLogs } from "./lib/contributor-status";
import { readRemixBond } from "@creaton/core/launchpad/remixBond.ts";
import {
  addressTopic,
  decodeAddress,
  decodeWord,
  encodeCall0,
} from "@creaton/core/launchpad/work.ts";
import type { Launch } from "./models";
import {
  encodeAllowance,
  encodeBalanceOf,
} from "@creaton/core/launchpad/workBounty.ts";
import { endpointChain } from "./use-work";

/** Where every query about remix bonds lives, so a step sent from one re-reads them all. */
export const REMIX_BOND_QUERY = ["launchpad", "remix-bond"] as const;

const coordinateOf = (launch: Launch) =>
  `37001:${launch.record.author}:${launch.record.id}`;

/**
 * A remix's latest own bond to its parent (N12), who may post it, the court's fee for a case, and the connected
 * wallet's CREATE and fee money, when this build names the bond contract. The bond is the project's only if its DAO or
 * its founder posted it (the founder as the contributor kit's launch event names them, not as the record says).
 */
export function useRemixBond(
  remix: Launch,
  parent: Launch,
  wallet: string | null,
) {
  const chainId = defaultChainPreset().chainId;
  const contract = remixBonds(chainId);
  const court = courtAddress(chainId);
  const create = createToken(chainId);
  const kit = contributorKit(String(chainId));
  const dao = remix.record.treasury?.toLowerCase() ?? null;
  const coordinate = coordinateOf(remix);
  const query = useQuery({
    queryKey: [...REMIX_BOND_QUERY, contract, coordinate, wallet],
    enabled: contract !== null && court !== null && create !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      const launched =
        kit && dao
          ? await kitLaunchLogs(
              (topics) => chain.logs({ address: kit, topics }),
              addressTopic(dao),
            )
          : [];
      const topic = (launched[0] as { topics?: string[] } | undefined)
        ?.topics?.[1];
      const founder = topic ? `0x${topic.slice(-40)}`.toLowerCase() : null;
      const posters = [dao, founder].filter((a): a is string => a !== null);
      const [bond, now, fee, feeToken] = await Promise.all([
        readRemixBond(chain, contract as string, coordinate, {
          posters,
          parent: coordinateOf(parent),
          parentDao: parent.record.treasury ?? "",
        }),
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
        founder,
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
