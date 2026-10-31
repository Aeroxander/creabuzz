/**
 * Who has handed this person their vote on decisions: the holders whose allocation delegate (set by a DAO vote,
 * `AllocationVoting.delegateOf`) is the viewer. A decision card offers "vote for them" only for these people, by name,
 * and never asks anyone to paste an address.
 *
 * Only the listed holders are asked (the largest few, as the holders list reads them), so someone further down that
 * list who delegated is not offered here; that is said where it matters, never guessed. The chain is injected, so
 * `allocation-delegators.test.mjs` runs the real reader against a fake one. Alias-free for `node --test`.
 */

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import { decodeAddress, encodeCall0, SIGNATURES } from "./work.ts";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** The holders (of those listed) whose vote this account may cast, in the order given. */
export async function readDelegatorsTo(
  chain: { call(to: string, data: string): Promise<string> },
  dao: string,
  account: string,
  holders: readonly string[],
): Promise<string[]> {
  const me = account.toLowerCase();
  const others = holders.filter((holder) => holder.toLowerCase() !== me);
  if (others.length === 0) return [];
  const policy = decodeAddress(
    await chain.call(dao, encodeCall0(SIGNATURES.policy)),
  );
  if (policy === ZERO_ADDRESS) return [];
  const delegates = await Promise.all(
    others.map(async (holder) =>
      decodeAddress(
        await chain.call(
          policy,
          encodeFunctionData("delegateOf(address)", ["address"], [holder]),
        ),
      ),
    ),
  );
  return others.filter((_, index) => delegates[index].toLowerCase() === me);
}
