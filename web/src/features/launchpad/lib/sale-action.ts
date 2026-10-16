/**
 * What the one main button on a sale page offers, from where the sale really is.
 *
 * It used to say "Back this launch" in every state except a finished one, so a sale that had missed its minimum, or whose
 * bidding had closed, still invited a bid. The rule: bid only while bidding is open; once the buyers can act, offer what
 * they can do (claim tokens when the sale was funded, claim a refund when it was not); between the two say that bidding
 * is closed; before a sale exists offer nothing here (following is its own button).
 *
 * Pure and alias-free: `sale-action.test.mjs` drives it under `node --test`.
 */

import type { ChainRaise } from "./funding.ts";

export type SaleAction =
  | { kind: "bid"; label: "Place bid" }
  | { kind: "closed"; label: "Bidding closed" }
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
}

export function saleAction(input: SaleActionInput): SaleAction | null {
  const { raise, stage, hasAuction, progress } = input;
  if (stage === "graduated") {
    return hasAuction ? { kind: "claim", label: "Claim tokens" } : null;
  }
  if (stage === "failed") {
    return hasAuction ? { kind: "refund", label: "Claim refund" } : null;
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
