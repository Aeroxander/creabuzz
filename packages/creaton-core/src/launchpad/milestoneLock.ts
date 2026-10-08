/**
 * The team's milestone lock, seen from a client (`contracts/src/MilestoneLock.sol`).
 *
 * A DAO launched through the kit mints the team's Shares to the team, and part of them stay locked (they can be
 * voted with, not sold and not taken out in a ragequit) until a milestone is reached. A milestone is a work claim: the
 * beneficiary files it in a mandate their DAO created, states the exact words the milestone is judged by, and the
 * mandate's reviewers approve it. This module reads the lock, finds the claims that can unlock a tranche, and builds
 * the one call that does.
 *
 * Every read is bounded (a lock has at most {@link MAX_LOCK_TRANCHES} tranches) and the chain is injected, so
 * `milestoneLock.test.mjs` runs the real reader against a fake one.
 */

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  decodeAddress,
  decodeBool,
  decodeWord,
  type ClaimView,
  encodeCall0,
} from "./work.ts";
import type { WorkChain, WorkSnapshot } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** The lock's own cap (`MilestoneLock.MAX_TRANCHES`): reading further would be reading nothing. */
export const MAX_LOCK_TRANCHES = 8;

export const LOCK_SIGNATURES = {
  daoShares: "shares()",
  sharesLockGuard: "lockGuard()",
  lockedOf: "lockedOf(address)",
  trancheCount: "trancheCount(address)",
  trancheOf: "trancheOf(address,uint256)",
  claimUsed: "claimUsed(address,bytes32)",
  unlock: "unlock(address,uint256,address,bytes32)",
} as const;

export const SELECTOR_LOCK_UNLOCK = selectorOf(LOCK_SIGNATURES.unlock);

export interface MilestoneTranche {
  index: number;
  /** keccak256 of the words this milestone is judged by (the claim's check must be exactly this). */
  checkHash: string;
  /** Share base units this tranche holds back. */
  amount: bigint;
  unlocked: boolean;
  forfeited: boolean;
}

export interface MilestoneLockView {
  /** The lock contract, as the DAO's Shares names it. */
  lock: string;
  holder: string;
  /** What the holder cannot move yet: the tranches neither unlocked nor forfeited. */
  locked: bigint;
  tranches: MilestoneTranche[];
}

const word = (hex: string, i: number): bigint => {
  const body = hex.replace(/^0x/, "");
  return BigInt(`0x${body.slice(i * 64, (i + 1) * 64) || "0"}`);
};

function assertAddress(value: string, what: string): void {
  if (!ADDRESS_RE.test(value)) throw new Error(`${what} is not an address`);
}

/** The one call that unlocks a tranche. Anyone may send it; it only works for a claim that qualifies. */
export function encodeUnlock(
  beneficiary: string,
  index: number,
  mandate: string,
  claimId: string,
): string {
  assertAddress(beneficiary, "the beneficiary");
  assertAddress(mandate, "the mandate");
  if (!WORD_RE.test(claimId))
    throw new Error("the claim id must be 0x + 64 hex characters");
  if (!Number.isInteger(index) || index < 0 || index >= MAX_LOCK_TRANCHES) {
    throw new Error("that milestone does not exist");
  }
  return encodeFunctionData(
    LOCK_SIGNATURES.unlock,
    ["address", "uint256", "address", "bytes32"],
    [beneficiary, BigInt(index), mandate, claimId],
  );
}

/**
 * The lock holding `holder`'s team Shares, or null when the DAO has none (it was not launched with one, or the guard
 * has been removed). The lock is found from the Shares contract, not from a record: only the Shares contract's own
 * answer decides what can move.
 */
export async function readMilestoneLock(
  chain: Pick<WorkChain, "call">,
  dao: string,
  holder: string,
): Promise<MilestoneLockView | null> {
  assertAddress(dao, "the DAO");
  assertAddress(holder, "the holder");
  const shares = decodeAddress(
    await chain.call(dao, encodeCall0(LOCK_SIGNATURES.daoShares)),
  );
  if (shares === ZERO_ADDRESS) return null;
  const lock = decodeAddress(
    await chain.call(shares, encodeCall0(LOCK_SIGNATURES.sharesLockGuard)),
  );
  if (lock === ZERO_ADDRESS) return null;

  const [lockedHex, countHex] = await Promise.all([
    chain.call(
      lock,
      encodeFunctionData(LOCK_SIGNATURES.lockedOf, ["address"], [holder]),
    ),
    chain.call(
      lock,
      encodeFunctionData(LOCK_SIGNATURES.trancheCount, ["address"], [holder]),
    ),
  ]);
  const count = Math.min(Number(decodeWord(countHex)), MAX_LOCK_TRANCHES);
  const tranches = await Promise.all(
    Array.from(
      { length: count },
      async (_, index): Promise<MilestoneTranche> => {
        const hex = await chain.call(
          lock,
          encodeFunctionData(
            LOCK_SIGNATURES.trancheOf,
            ["address", "uint256"],
            [holder, BigInt(index)],
          ),
        );
        return {
          index,
          checkHash: `0x${word(hex, 0).toString(16).padStart(64, "0")}`,
          amount: word(hex, 1),
          unlocked: word(hex, 2) !== 0n,
          forfeited: word(hex, 3) !== 0n,
        };
      },
    ),
  );
  return { lock, holder, locked: decodeWord(lockedHex), tranches };
}

export interface UnlockOffer {
  tranche: MilestoneTranche;
  mandate: string;
  claimId: string;
}

/** A claim that the lock would accept for `tranche` (everything but whether it was already spent on another). */
function qualifies(
  claim: ClaimView,
  holder: string,
  tranche: MilestoneTranche,
): boolean {
  return (
    claim.record.contributor.toLowerCase() === holder.toLowerCase() &&
    claim.record.status === "Paid" &&
    claim.record.checkHash.toLowerCase() === tranche.checkHash.toLowerCase() &&
    claim.project !== null
  );
}

/**
 * For each tranche still locked, the claim that would unlock it, if there is one: the holder's own, approved by the
 * reviewers and past the challenge window, filed against exactly the tranche's words, and not already spent on another
 * tranche. A claim is spent once, so the lock is asked.
 */
export async function findUnlockOffers(
  chain: Pick<WorkChain, "call">,
  view: MilestoneLockView,
  work: WorkSnapshot,
): Promise<UnlockOffer[]> {
  const offers: UnlockOffer[] = [];
  const taken = new Set<string>();
  for (const tranche of view.tranches) {
    if (tranche.unlocked || tranche.forfeited) continue;
    for (const mandate of work.mandates) {
      let found: UnlockOffer | null = null;
      for (const claim of mandate.claims) {
        const key = `${mandate.address}:${claim.id}`.toLowerCase();
        if (taken.has(key) || !qualifies(claim, view.holder, tranche)) continue;
        const used = decodeBool(
          await chain.call(
            view.lock,
            encodeFunctionData(
              LOCK_SIGNATURES.claimUsed,
              ["address", "bytes32"],
              [mandate.claimsAddress, claim.id],
            ),
          ),
        );
        if (used) continue;
        found = { tranche, mandate: mandate.address, claimId: claim.id };
        taken.add(key);
        break;
      }
      if (found) {
        offers.push(found);
        break;
      }
    }
  }
  return offers;
}
