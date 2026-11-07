/**
 * Build and validate the onchain bid/exit/claim calls of the CCA auction.
 *
 * The chain is the ledger; this module is the composer. Every selector and
 * layout here mirrors the vendored contract
 * (`contracts/lib/continuous-clearing-auction/src/ContinuousClearingAuction.sol`
 * and `TickStorage.sol`) and its pinned mirrors
 * (`contracts/test/PinnedInterfaces.t.sol`, web `chain.ts`). There is no wallet
 * library in this app, so encoding is done by hand: fixed-width head words and
 * one dynamic tail (the `bytes` hookData of `submitBid`). Selectors were
 * derived with keccak-256 and cross-checked with `cast sig`; the production
 * path never recomputes them at runtime.
 *
 * The bids this module emits are *unsigned transactions*. Signing stays in the
 * wallet (window.ethereum) or in an agent's key; this module only guarantees
 * the bytes the contract will accept — the same seam the fork test binds.
 */

// Extension included on purpose: this module is driven by `bid-tx.test.mjs`
// under `node --test`, which does not resolve extensionless specifiers.
import {
  PERMIT2_ADDRESS,
  SELECTOR_CLAIM_TOKENS,
  SELECTOR_CLAIM_TOKENS_BATCH,
  SELECTOR_ERC20_APPROVE,
  SELECTOR_EXIT_BID,
  SELECTOR_PERMIT2_APPROVE,
  SELECTOR_SUBMIT_BID,
  bidPlanWithDefaultHint,
  encodeClaimTokens,
  encodeClaimTokensBatch,
  encodeErc20Approve,
  encodeExitBid,
  encodeExitPartiallyFilledBid,
  encodePermit2Approve,
  encodeSubmitBid,
} from "@creaton/core/launchpad/evmCalls.ts";
import type { BidPlan } from "@creaton/core/launchpad/evmCalls.ts";

/** The encoders live once, in `@creaton/core`; they are re-exported here so this module's callers keep one import site. */
export {
  PERMIT2_ADDRESS,
  SELECTOR_CLAIM_TOKENS,
  SELECTOR_CLAIM_TOKENS_BATCH,
  SELECTOR_ERC20_APPROVE,
  SELECTOR_EXIT_BID,
  SELECTOR_PERMIT2_APPROVE,
  SELECTOR_SUBMIT_BID,
  bidPlanWithDefaultHint,
  encodeClaimTokens,
  encodeClaimTokensBatch,
  encodeErc20Approve,
  encodeExitBid,
  encodeExitPartiallyFilledBid,
  encodePermit2Approve,
  encodeSubmitBid,
};
export type { BidPlan };

import { maxBidPrice } from "./launch-params.ts";
// checkpoint() — materialize the current block's checkpoint
const SELECTOR_CHECKPOINT = "0xc2c4c5c1";
// allowance(address,address) on the ERC-20 currency
const SELECTOR_ERC20_ALLOWANCE = "0xdd62ed3e";

export interface UnsignedTx {
  to: string;
  /** Hex wei sent with the call: "0x0" everywhere except a native-currency bid. */
  value: `0x${string}`;
  data: string;
}

export interface BidIssue {
  field: "amount" | "maxPrice" | "network";
  severity: "error" | "warning";
  message: string;
}

/**
 * Validate a bid against the exact rules the contract enforces in `_submitBid`
 * and `TickStorage._getTick`, before anything is signed:
 *
 * - `maxPriceQ96 % tickSpacingQ96 == 0` (tick-aligned; `TickPriceNotAtBoundary`)
 * - `maxPriceQ96 > clearingPriceQ96` (`BidMustBeAboveClearingPrice`)
 * - `maxPriceQ96 <= MAX_BID_PRICE` computed from supply (`InvalidBidPriceTooHigh`)
 * - `amount > 0` (`BidAmountTooSmall`)
 *
 * A bid that passes this list is still not guaranteed to land (the hook can
 * reject, the auction can sell out); an issue raised here is guaranteed to
 * revert onchain, so the wallet should refuse to sign.
 */
export function validateBid(
  plan: BidPlan,
  context: {
    tickSpacingQ96: bigint;
    clearingPriceQ96: bigint;
    /** Auction `TOTAL_SUPPLY`; `null` when the record does not carry it. */
    supply: bigint | null;
  },
): BidIssue[] {
  const issues: BidIssue[] = [];
  if (plan.amount <= 0n) {
    issues.push({
      field: "amount",
      severity: "error",
      message: "The bid needs a budget greater than zero.",
    });
  }
  if (context.supply !== null) {
    const ceiling = maxBidPrice(context.supply);
    if (plan.maxPriceQ96 > ceiling) {
      issues.push({
        field: "maxPrice",
        severity: "error",
        message:
          "Your highest price is above the ceiling the token supply allows, so the bid won't go through. Lower your highest price.",
      });
    }
  }
  if (
    context.tickSpacingQ96 > 0n &&
    plan.maxPriceQ96 % context.tickSpacingQ96 !== 0n
  ) {
    issues.push({
      field: "maxPrice",
      severity: "error",
      message:
        "Your highest price must be a multiple of this sale's price step, or the bid won't go through.",
    });
  }
  if (plan.maxPriceQ96 <= context.clearingPriceQ96) {
    issues.push({
      field: "maxPrice",
      severity: "error",
      message: "Your highest price must be above the current clearing price.",
    });
  }
  return issues;
}

/**
 * Snap a desired Q96 price onto the auction's tick grid — the smallest price
 * at or above `desired` that is a multiple of `tickSpacingQ96`. Mirrors the
 * invariant `TickStorage._getTick` enforces (price % spacing == 0).
 */
export function snapMaxPriceToTick(
  desiredQ96: bigint,
  tickSpacingQ96: bigint,
): bigint {
  if (tickSpacingQ96 <= 0n) return desiredQ96;
  const snapped = desiredQ96 - (desiredQ96 % tickSpacingQ96);
  // A bid at or below the clearing price fills at most partially; snapping up
  // keeps the user's intended premium rather than silently undercutting it.
  return snapped === desiredQ96 ? snapped : snapped + tickSpacingQ96;
}

function pad32(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function encodeAddress(a: string): string {
  const h = a.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`invalid address: ${a}`);
  return pad32(BigInt(`0x${h}`));
}

/** ABI-encode the bare `checkpoint()` call (no args). */
export function encodeCheckpointCallData(): string {
  return SELECTOR_CHECKPOINT;
}

/** ABI-encode `allowance(owner, spender)` on the ERC-20 currency. */
export function encodeErc20Allowance(owner: string, spender: string): string {
  return `0x${SELECTOR_ERC20_ALLOWANCE.slice(2)}${encodeAddress(owner)}${encodeAddress(spender)}`;
}

/**
 * Whether the ERC-20 approval to Permit2 must be sent before the bid. An
 * unknown allowance (`null`/`undefined`: the read failed) is treated as
 * insufficient — an unneeded approve costs a little gas, a missing one reverts
 * the whole bid.
 */
function needsUnderlyingApproval(
  allowance: bigint | null | undefined,
  amount: bigint,
): boolean {
  return allowance === null || allowance === undefined || allowance < amount;
}

/** Convenience: the full unsigned tx for a bid on an ERC-20-currency auction. */
export function buildBidTransaction(
  auctionAddress: string,
  plan: BidPlan,
): UnsignedTx {
  return { to: auctionAddress, value: "0x0", data: encodeSubmitBid(plan) };
}

/**
 * Compose the full ordered call list of a bid: the ERC-20 approve to Permit2
 * (only when the bidder's allowance is short), the Permit2 approval
 * (ERC-20-currency auctions), then `submitBid`. This is THE composer
 * behind both send paths in `ui/RecordBidDialog.tsx`: the injected wallet sends
 * these calls via sequential `eth_sendTransaction`, the passkey account sends
 * them through `identity/lib/sponsoredSender.ts`. The sender swap must never
 * change these bytes — `identity/lib/sponsoredSender.test.mjs` binds that
 * parity at both adapters' wire boundaries.
 *
 * `plan.owner` is sender-chosen and is the only sender-dependent input: the
 * CCA budget is pulled from the CALLER (`ContinuousClearingAuction.sol`
 * `submitBid` → `permit2TransferFrom(..., msg.sender, ...)`), while `owner`
 * receives tokens and refunds. Nothing here assumes `msg.sender == owner`.
 * A native-currency (ETH) auction is a single `submitBid` carrying the bid
 * amount as its value; an ERC-20 one is the approve legs then a zero-value bid.
 */
export function buildBidCalls(input: {
  auction: string;
  plan: BidPlan;
  /** ERC-20 currency address, or null/other for a non-ERC-20 auction. */
  currency: string | null;
  /** Permit2 approval deadline (unix seconds). */
  deadline: bigint;
  /**
   * The bidder's current ERC-20 allowance to Permit2 (`allowance(owner,
   * PERMIT2)`), when the caller could read it. Absent/`null` = unknown, which
   * composes the ERC-20 approve.
   */
  underlyingAllowance?: bigint | null;
}): UnsignedTx[] {
  const calls: UnsignedTx[] = [];
  const currency = input.currency;
  if (currency && /^0x[0-9a-fA-F]{40}$/.test(currency)) {
    if (needsUnderlyingApproval(input.underlyingAllowance, input.plan.amount)) {
      // Leg 1: holder -> Permit2 on the token itself.
      calls.push({
        to: currency,
        value: "0x0",
        data: encodeErc20Approve(PERMIT2_ADDRESS, input.plan.amount),
      });
    }
    // Leg 2: Permit2 -> auction, bounded by amount and deadline.
    calls.push({
      to: PERMIT2_ADDRESS,
      value: "0x0",
      data: encodePermit2Approve(
        currency,
        input.auction,
        input.plan.amount,
        input.deadline,
      ),
    });
  }
  const bid = buildBidTransaction(input.auction, input.plan);
  // A native-currency auction takes the bid amount as the call's ETH value
  // (`submitBid` reverts InvalidAmount unless `msg.value == amount`); an ERC-20
  // auction takes none (`CurrencyIsNotNative`).
  const native = !(currency && /^0x[0-9a-fA-F]{40}$/.test(currency));
  calls.push(
    native ? { ...bid, value: `0x${input.plan.amount.toString(16)}` } : bid,
  );
  return calls;
}
