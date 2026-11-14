/**
 * What a wallet holds in each DAO and for how long, read from the chain.
 *
 * The DAO's voting policy keeps, for every holder, the weighted-average moment they acquired their Shares
 * (`holdingAge`): receiving Shares blends the time in, sending changes nothing, and Shares passed to another wallet do
 * not take their time with them. This reads it, and how much of the holding is still locked behind milestones, for each
 * wallet the person might hold from.
 *
 * A DAO whose policy has no `holdingAge` (one made before the ledger existed) is left out, not reported as a failure.
 * A read that fails for any other reason is reported as failed, never as "holds nothing" (Review-Proven Rule 1). Every
 * read is bounded by the caller. The chain is injected, so `holdings.test.mjs` runs the real reader against a fake one.
 * Alias-free for `node --test`.
 */

import { readMilestoneLock } from "@creaton/core/launchpad/milestoneLock.ts";
import {
  decodeAddress,
  decodeWord,
  encodeCall0,
  SIGNATURES,
} from "@creaton/core/launchpad/work.ts";
import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const HOLDING_AGE = "holdingAge(address)";

export interface HoldingView {
  dao: string;
  /** The wallet it is held in (lower case). */
  owner: string;
  /** Shares held, in base units. */
  balance: bigint;
  /** Of those, the Shares still locked behind milestones. */
  locked: bigint;
  /** Seconds the holding has lasted, by the weighted average. */
  age: number;
  /** Unix seconds the holding started, by the same average (the chain's clock minus the age). */
  since: number;
}

export interface HoldingsRead {
  holdings: HoldingView[];
  /** DAOs that could not be read: unknown, not empty. */
  failed: string[];
}

const isRevert = (error: unknown): boolean =>
  error instanceof Error && /revert/i.test(error.message);

/** One wallet's holding in one DAO, or null when it holds nothing there. Throws for a read that failed. */
async function readOne(
  chain: WorkChain,
  dao: string,
  policy: string,
  owner: string,
  chainTime: number,
): Promise<HoldingView | null> {
  const hex = await chain.call(
    policy,
    encodeFunctionData(HOLDING_AGE, ["address"], [owner]),
  );
  const balance = decodeWord(hex);
  if (balance === 0n) return null;
  const age = Number(decodeWord(`0x${hex.replace(/^0x/, "").slice(64)}`));
  const lock = await readMilestoneLock(chain, dao, owner);
  return {
    dao,
    owner,
    balance,
    locked: lock?.locked ?? 0n,
    age,
    since: chainTime - age,
  };
}

/** Each wallet's holding in each DAO, for the DAOs given (the caller bounds how many). */
export async function readHoldings(
  chain: WorkChain,
  daos: readonly string[],
  owners: readonly string[],
): Promise<HoldingsRead> {
  const chainTime = await chain.now();
  const holdings: HoldingView[] = [];
  const failed: string[] = [];
  await Promise.all(
    daos.map(async (dao) => {
      try {
        const policy = decodeAddress(
          await chain.call(dao, encodeCall0(SIGNATURES.policy)),
        );
        if (policy === ZERO_ADDRESS) return;
        for (const owner of owners) {
          const one = await readOne(chain, dao, policy, owner, chainTime);
          if (one) holdings.push(one);
        }
      } catch (error) {
        // A DAO that predates the ledger answers `holdingAge` with a revert: it is not tracked, which is not an error.
        if (!isRevert(error)) failed.push(dao);
      }
    }),
  );
  holdings.sort((a, b) => b.age - a.age);
  return { holdings, failed };
}

const DAY = 86_400;

/** How long, in words a person says it: "less than a day", "12 days", "5 months", "2 years". */
export function describeAge(seconds: number): string {
  const days = Math.floor(seconds / DAY);
  if (days < 1) return "less than a day";
  if (days < 2) return "1 day";
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months`;
  return `${Math.floor(days / 365)} years`;
}
