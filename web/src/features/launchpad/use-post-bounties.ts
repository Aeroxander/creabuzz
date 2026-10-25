import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import { defaultChainPreset, openBounty } from "./chain-config";
import { readPostBounties } from "./lib/open-bounty";
import { endpointChain } from "./use-work";

const keccakText = (text: string) =>
  `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** Where every query about bounties on posts lives, so a step sent from one re-reads them all. */
export const POST_BOUNTY_QUERY = ["launchpad", "post-bounties"] as const;

/**
 * The bounties on one post (N2), with the chain's own clock, when this build names a bounty contract for its network.
 * `post` is the post's event id (64 hex characters).
 */
export function usePostBounties(post: string | null, wallet: string | null) {
  const chainId = defaultChainPreset().chainId;
  const contract = openBounty(chainId);
  const postWord = post && /^[0-9a-f]{64}$/.test(post) ? `0x${post}` : null;
  const query = useQuery({
    queryKey: [...POST_BOUNTY_QUERY, postWord, wallet, contract],
    enabled: contract !== null && postWord !== null,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      const [read, chainTime] = await Promise.all([
        readPostBounties(
          chain,
          contract as string,
          postWord as string,
          wallet,
          keccakText,
        ),
        chain.now(),
      ]);
      return { ...read, chainTime };
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  return { chainId, contract, postWord, query };
}
