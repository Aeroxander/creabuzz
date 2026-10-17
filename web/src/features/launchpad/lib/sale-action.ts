/**
 * What the one main button on a sale page offers, from where the sale really is.
 *
 * It used to say "Back this launch" in every state except a finished one, so a sale that had missed its minimum, or whose
 * bidding had closed, still invited a bid. The rule: bid only while bidding is open; once the buyers can act, offer what
 * they can do (claim tokens when the sale was funded, claim a refund when it was not); between the two say that bidding
 * is closed; before a sale exists offer nothing here (following is its own button).
 *
 * The auction outranks the record's saved stage label. A launched project has a real auction with its own clock, and the
 * contract's rules decide: bids are refused from the end block on (the end block itself is closed), a bid is refunded in
 * full once the auction is over and missed its minimum, and tokens are claimed from the claim block on if it was met.
 * Only a launch the chain could not be read for falls back to the saved label, and never to a guess that the buyers may act.
 *
 * Pure and alias-free: `sale-action.test.mjs` drives it under `node --test`.
 */

import { chainRaise, type ChainRaise, type FundingLaunch } from "./funding.ts";

export type SaleAction =
  | { kind: "bid"; label: "Place bid" }
  | { kind: "closed"; label: "Bidding closed" | "Bidding not open yet" }
  | { kind: "claim"; label: "Claim tokens" }
  | { kind: "refund"; label: "Claim refund" };

const BID: SaleAction = { kind: "bid", label: "Place bid" };
const CLAIM: SaleAction = { kind: "claim", label: "Claim tokens" };
const REFUND: SaleAction = { kind: "refund", label: "Claim refund" };
const CLOSED: SaleAction = { kind: "closed", label: "Bidding closed" };
const NOT_YET: SaleAction = { kind: "closed", label: "Bidding not open yet" };

export interface SaleActionInput {
  /** Where the record and receipts say the raise is (`chainRaise`); used only when the auction cannot be read. */
  raise: ChainRaise;
  /** The launch's stage once settlement receipts are taken into account (`effectiveStage`). */
  stage: "draft" | "review" | "live" | "funding" | "graduated" | "failed";
  /** The launch has a linked auction contract: with none there is nothing to claim or refund. */
  hasAuction: boolean;
  /** The auction read from the chain: `graduated` once the minimum raise is met (it can be true while bidding is open). */
  progress?: { source: string; graduated: boolean };
  /** The sale's own clock, and the current block, when the chain could be read. */
  window?: {
    startBlock: number | null;
    endBlock: number | null;
    claimBlock: number | null;
    head: number | bigint | null;
  };
}

/** The main button for a launch, from its record and receipts, the current block and the auction read. */
export function saleActionFor(
  launch: FundingLaunch & {
    record: {
      auction: string | null;
      startBlock: number | null;
      claimBlock: number | null;
    };
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
      claimBlock: launch.record.claimBlock,
      head,
    },
  });
}

export function saleAction(input: SaleActionInput): SaleAction | null {
  const { raise, stage, hasAuction, progress, window } = input;
  const head = window?.head == null ? null : Number(window.head);
  const start = window?.startBlock ?? null;
  const end = window?.endBlock ?? null;
  const claim = window?.claimBlock ?? null;

  if (hasAuction && head !== null && start !== null && end !== null) {
    if (head < start) return NOT_YET;
    if (head < end) return BID;
    // The auction is over. What the buyers can do depends on whether it met its minimum, which only the chain can say.
    if (progress?.source !== "rpc") return CLOSED;
    if (!progress.graduated) return REFUND;
    return claim !== null && head >= claim ? CLAIM : CLOSED;
  }

  // The auction could not be read (or there is none): the saved label and receipts are all there is.
  if (stage === "graduated") return hasAuction ? CLAIM : null;
  if (stage === "failed") return hasAuction ? REFUND : null;
  if (raise === "none") return null;
  if (raise === "open") return BID;
  return hasAuction ? CLOSED : null;
}
