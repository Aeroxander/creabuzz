import {
  ethCall,
  ethChainId,
  getRpcEndpoint,
} from "@/features/launchpad/chain";

import { isValidKernelSignature } from "./kernel-signature";
import type { ChainChecker } from "./wallet-proof";

/** One answer per node: the network a node reads does not change under us. */
const chainIds = new Map<string, Promise<bigint>>();

function chainIdOf(endpoint: string): Promise<bigint> {
  let known = chainIds.get(endpoint);
  if (!known) {
    known = ethChainId(endpoint);
    chainIds.set(endpoint, known);
    // A failed answer is not kept: the next check asks again.
    known.catch(() => chainIds.delete(endpoint));
  }
  return known;
}

/**
 * How this site asks a chain whether a smart account accepts a signature (ERC-1271), through the site's own chain
 * connection. `undefined` when the site has none, in which case a smart account's proof can never be shown as
 * verified. A proof for a network this site does not read is refused up front instead of being asked the wrong chain.
 */
export function walletChainChecker(): ChainChecker | undefined {
  const endpoint = getRpcEndpoint();
  if (!endpoint) return undefined;
  return async (check) => {
    const served = Number(await chainIdOf(endpoint));
    if (served !== check.chain) {
      throw new Error(
        `This site reads chain ${served}, not chain ${check.chain}.`,
      );
    }
    return isValidKernelSignature(
      (tx) => ethCall(endpoint, tx.to, tx.data),
      check.account,
      check.digest,
      check.signature,
    );
  };
}

/** `fn` over `items`, at most `limit` at a time, in order. A node is not asked about two hundred accounts at once. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
