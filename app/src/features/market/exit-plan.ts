/**
 * How one bid is settled once the sale is finished, read from the auction itself. A bid whose top price is above where the
 * auction ended is settled with `exitBid`; one at exactly that price was only partly filled, and the auction wants two
 * hints for it: the last checkpoint block at which the price was still below the bid's top price, and (when the bid was
 * outbid earlier) the first block at which the price rose past it. The hints come from the auction's own checkpoint list,
 * walked from the block the bid started in. Every bid the app places names the top price, so an oversubscribed auction
 * leaves all of them partly filled: this is the common case at the best outcome, not an edge.
 *
 * Mirrors the contract's own checks (`ContinuousClearingAuction.exitPartiallyFilledBid`); `tests/anvil/oversubscribed.test.ts`
 * proves it on a real EVM.
 */
import {
  encodeExitBid,
  encodeExitPartiallyFilledBid,
} from "@creaton/core/launchpad/evmContractCalls.ts";
import type { MoneyCall } from "../money/calls";
import type { MoneyWallet } from "../money/wallet";
import { MARKET_READS } from "./market-calls";

/** One checkpoint of the auction: the block it was written at, the price then, and the next one's block. */
export interface Checkpoint {
  block: bigint;
  clearingPrice: bigint;
  next: bigint;
}

/** What settles a bid. */
export type ExitPlan =
  | { kind: "exit" }
  | { kind: "partial"; lastFullyFilled: bigint; outbid: bigint }
  | { kind: "unavailable"; reason: "unfinished" | "inconsistent" };

/** The `next` of the last checkpoint (`CheckpointStorage.MAX_BLOCK_NUMBER`). */
const LAST = (1n << 64n) - 1n;

/** How many checkpoints one walk reads at most: more is reported, never cut short (Review-Proven Rule 4). */
const WALK_LIMIT = 512;

/**
 * The plan for a bid, from its top price, the block it started in, the checkpoints from there on (ascending), whether the
 * auction reached its minimum and the block it ends at. Pure.
 */
export function planExit(input: {
  maxPrice: bigint;
  startBlock: bigint;
  checkpoints: readonly Checkpoint[];
  graduated: boolean;
  endBlock: bigint;
}): ExitPlan {
  // Under its minimum every bid comes back whole.
  if (!input.graduated) return { kind: "exit" };
  const { maxPrice, checkpoints } = input;
  const first = checkpoints[0];
  if (
    !first ||
    first.block !== input.startBlock ||
    first.clearingPrice >= maxPrice
  )
    return { kind: "unavailable", reason: "inconsistent" };
  let lastBelow: Checkpoint | null = null;
  for (const cp of checkpoints) {
    if (cp.clearingPrice > maxPrice) {
      // Outbid at this checkpoint: the early path, which needs the last one below.
      if (!lastBelow) return { kind: "unavailable", reason: "inconsistent" };
      return {
        kind: "partial",
        lastFullyFilled: lastBelow.block,
        outbid: cp.block,
      };
    }
    if (cp.clearingPrice < maxPrice) lastBelow = cp;
  }
  // Never outbid: what decides is the price at the very end, which is written once the sale is finished.
  const tail = checkpoints[checkpoints.length - 1];
  if (tail.block < input.endBlock)
    return { kind: "unavailable", reason: "unfinished" };
  if (maxPrice > tail.clearingPrice) return { kind: "exit" };
  if (maxPrice === tail.clearingPrice && lastBelow)
    return { kind: "partial", lastFullyFilled: lastBelow.block, outbid: 0n };
  return { kind: "unavailable", reason: "inconsistent" };
}

const words = (hex: string) =>
  (hex.replace(/^0x/, "").match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));

/** The bid's start block, exit block and top price, and the auction's checkpoints from that block on. */
export async function readExitPlan(
  wallet: Pick<MoneyWallet, "readCall">,
  auction: string,
  bidId: bigint,
): Promise<ExitPlan> {
  const [bid, graduated, endBlock] = await Promise.all([
    wallet.readCall(auction, MARKET_READS.bid(bidId)).then(words),
    wallet.readCall(auction, MARKET_READS.isGraduated).then(words),
    wallet.readCall(auction, MARKET_READS.endBlock).then(words),
  ]);
  if (bid.length < 7 || graduated.length < 1 || endBlock.length < 1)
    throw new Error("The bid could not be read.");
  const [startBlock, , exitedBlock, maxPrice] = bid;
  if (exitedBlock !== 0n)
    return { kind: "unavailable", reason: "inconsistent" };
  if (graduated[0] === 0n) return { kind: "exit" };
  const checkpoints: Checkpoint[] = [];
  let at = startBlock;
  for (let steps = 0; ; steps += 1) {
    if (steps >= WALK_LIMIT)
      return { kind: "unavailable", reason: "inconsistent" };
    const w = words(
      await wallet.readCall(auction, MARKET_READS.checkpoint(at)),
    );
    // A block without a checkpoint reads as all zeros: the walk cannot go on from it.
    if (w.length < 6 || w[5] === 0n)
      return { kind: "unavailable", reason: "inconsistent" };
    checkpoints.push({ block: at, clearingPrice: w[0], next: w[5] });
    if (w[5] === LAST) break;
    if (w[5] <= at) return { kind: "unavailable", reason: "inconsistent" };
    at = w[5];
  }
  return planExit({
    maxPrice,
    startBlock,
    checkpoints,
    graduated: true,
    endBlock: endBlock[0],
  });
}

/** The call that settles a bid by its plan. */
export function exitCall(
  auction: string,
  bidId: bigint,
  plan: Extract<ExitPlan, { kind: "exit" | "partial" }>,
): MoneyCall {
  return {
    to: auction.toLowerCase(),
    value: "0x0",
    data:
      plan.kind === "exit"
        ? encodeExitBid(bidId)
        : encodeExitPartiallyFilledBid(
            bidId,
            plan.lastFullyFilled,
            plan.outbid,
          ),
  };
}
