/**
 * What the one main button on a sale page offers, from where the sale really is.
 *
 * It used to say "Back this launch" in every state except a finished one, so a sale that had missed its minimum, or whose
 * bidding had closed, still invited a bid. The rule: bid only while bidding is open; once the buyers can act, offer what
 * they can do (claim tokens when the sale was funded, claim a refund when it was not); between the two say that bidding
 * is closed; before a sale exists offer nothing here (following is its own button).
 *
 * The chain outranks the record's stage label: a founder who has launched the project has a real auction running, and it
 * is open to bids from its start block to its end block whether or not the record has been set to Live. Without a
 * reading of the chain the stage decides, as before.
 *
 * Pure and alias-free: `sale-action.test.mjs` drives it under `node --test`.
 */

import { chainRaise, type ChainRaise, type FundingLaunch } from "./funding.ts";

export type SaleAction =
  | { kind: "bid"; label: "Place bid" }
  | { kind: "closed"; label: "Bidding closed" | "Bidding not open yet" }
  | { kind: "claim"; label: "Claim tokens" }
  | { kind: "refund"; label: "Claim refund" };

export interface SaleActionInput {
  /** Where the chain says the raise is (`chainRaise`). */
  raise: ChainRaise;
  /** The launch's stage once settlement receipts are taken into account (`effectiveStage`). */
  stage: "draft" | "review" | "live" | "funding" | "graduated" | "failed";
  /** The launch has a linked auction contract: with none there is nothing to claim or refund. */
  hasAuction: boolean;
  /** The auction read: `ended` once the buyers can claim; `graduated` once the minimum raise was met. */
  progress?: { source: string; ended: boolean; graduated: boolean };
  /** The sale's own bidding window and the current block, when the chain could be read. */
  window?: {
    startBlock: number | null;
    endBlock: number | null;
    head: number | bigint | null;
  };
}

/** The main button for a launch, from its record and receipts, the current block and the auction read. */
export function saleActionFor(
  launch: FundingLaunch & {
    record: { auction: string | null; startBlock: number | null };
  },
  stage: SaleActionInput["stage"],
  head: number | bigint | null,
  progress: SaleActionInput["progress"],
): SaleAction | null {
  return saleAction({
    raise: chainRaise(launch, head),
    stage,
    hasAuction: Boolean(launch.record.auction),
    progress,
    window: {
      startBlock: launch.record.startBlock,
      endBlock: launch.record.endBlock,
      head,
    },
  });
}

export function saleAction(input: SaleActionInput): SaleAction | null {
  const { raise, stage, hasAuction, progress, window } = input;
  const head = window?.head == null ? null : Number(window.head);
  const known =
    hasAuction &&
    head !== null &&
    window?.startBlock != null &&
    window?.endBlock != null;
  if (stage === "graduated") {
    return hasAuction ? { kind: "claim", label: "Claim tokens" } : null;
  }
  if (stage === "failed") {
    return hasAuction ? { kind: "refund", label: "Claim refund" } : null;
  }
  if (known && head !== null) {
    const { startBlock, endBlock } = window as {
      startBlock: number;
      endBlock: number;
    };
    if (head >= startBlock && head <= endBlock) {
      return { kind: "bid", label: "Place bid" };
    }
    if (head < startBlock) {
      return { kind: "closed", label: "Bidding not open yet" };
    }
  }
  if (raise === "none") return null;
  if (raise === "open") return { kind: "bid", label: "Place bid" };
  // Bidding has ended. Without an auction to read there is nothing to claim.
  if (!hasAuction) return null;
  // Only a reading from the chain can say the buyers may act now; anything less is "closed", never a guess.
  if (progress?.source === "rpc" && progress.ended) {
    return progress.graduated
      ? { kind: "claim", label: "Claim tokens" }
      : { kind: "refund", label: "Claim refund" };
  }
  return { kind: "closed", label: "Bidding closed" };
}
