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
import { Q96, maxBidPrice, MIN_FLOOR_PRICE } from "./launch-params.ts";

/** Canonical Permit2 (used by every CCA deployment for currency pulls). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * The contract's default previous-tick hint when the caller does not know the
 * auction's floor. `submitBid` without an explicit `_prevTickPriceQ96` uses
 * `FLOOR_PRICE_Q96` — the first initialized tick — which is always a valid
 * (gas-inefficient, never wrong) hint. Callers who know the launch record
 * SHOULD pass `record.floorPrice` instead: any price below the *auction's own*
 * floor is a non-initialized tick and `_initializeTickIfNeeded` would revert
 * (`TickPreviousPrice`). This constant only exists for the record-less path.
 */
export const DEFAULT_PREV_TICK_PRICE_Q96 = MIN_FLOOR_PRICE;

// Selectors, keccak-256 first 4 bytes of the canonical signature.
// submitBid(uint256,uint128,address,uint256,bytes)
export const SELECTOR_SUBMIT_BID = "0xa52c8728";
// exitBid(uint256)
export const SELECTOR_EXIT_BID = "0x8e4deb17";
// exitPartiallyFilledBid(uint256,uint64,uint64)
export const SELECTOR_EXIT_PARTIALLY_FILLED_BID = "0x36dec5f2";
// checkpoint() — materialize the current block's checkpoint
export const SELECTOR_CHECKPOINT = "0xc2c4c5c1";
// claimTokens(uint256)
export const SELECTOR_CLAIM_TOKENS = "0x46e04a2f";
// claimTokensBatch(address,uint256[])
export const SELECTOR_CLAIM_TOKENS_BATCH = "0xb8f163d6";
// approve(address,address,uint160,uint48) on Permit2
export const SELECTOR_PERMIT2_APPROVE = "0x87517c45";

export interface BidPlan {
  maxPriceQ96: bigint;
  /** Bid budget in currency smallest units (USDC 6 decimals). */
  amount: bigint;
  /** The bidder receiving tokens and refunds. `address(0)` reverts onchain. */
  owner: string;
  /** Gas hint: Q96 price of the nearest initialized tick below maxPrice. */
  prevTickPriceQ96: bigint;
  hookData: string;
}

export interface UnsignedTx {
  to: string;
  value: "0x0";
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
        message: `This max price is above the supply's ceiling (${ceiling}); the contract would revert InvalidBidPriceTooHigh.`,
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
      message: `Max price must sit on the auction's tick grid (a multiple of ${context.tickSpacingQ96}); the contract would revert TickPriceNotAtBoundary.`,
    });
  }
  if (plan.maxPriceQ96 <= context.clearingPriceQ96) {
    issues.push({
      field: "maxPrice",
      severity: "error",
      message: "Max price must be above the current clearing price.",
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

/** ABI-encode `submitBid(uint256,uint128,address,uint256,bytes)`. */
export function encodeSubmitBid(plan: BidPlan): string {
  const hookData = plan.hookData.replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(hookData)) throw new Error("hookData must be hex");
  const tailBytesLen = hookData.length / 2;
  const head =
    SELECTOR_SUBMIT_BID.slice(2) +
    pad32(plan.maxPriceQ96) +
    pad32(plan.amount) +
    encodeAddress(plan.owner) +
    pad32(plan.prevTickPriceQ96) +
    pad32(0xa0n); // offset of hookData tail
  // ABI packs `bytes` right-padded to a multiple of 32 bytes, with its byte
  // length in a 32-byte word. Unpadded tails make calldata shorter than the
  // decoder expects and the whole call misparse.
  const paddedData = hookData.padEnd(Math.ceil(tailBytesLen / 32) * 64, "0");
  const tail = pad32(BigInt(tailBytesLen)) + paddedData;
  return `0x${head}${tail}`;
}

/** ABI-encode `exitBid(uint256)`. */
export function encodeExitBid(bidId: bigint): string {
  return `0x${SELECTOR_EXIT_BID.slice(2)}${pad32(bidId)}`;
}

/**
 * ABI-encode `exitPartiallyFilledBid(uint256,uint64,uint64)` — the refund of
 * the unfilled share of a partially filled (or outbid) bid. The two hints are
 * checkpoint block numbers the caller derives from the checkpoint walk
 * (`lib/my-bids.ts`); the contract validates them against its latest state and
 * reverts `InvalidLastFullyFilledCheckpointHint` / `InvalidOutbidBlock
 * CheckpointHint` when they are stale, so they must be derived fresh per send.
 */
export function encodeExitPartiallyFilledBid(
  bidId: bigint,
  lastFullyFilledCheckpointBlock: bigint,
  outbidBlock: bigint,
): string {
  return (
    "0x" +
    SELECTOR_EXIT_PARTIALLY_FILLED_BID.slice(2) +
    pad32(bidId) +
    pad32(lastFullyFilledCheckpointBlock) +
    pad32(outbidBlock)
  );
}

/** ABI-encode the bare `checkpoint()` call (no args). */
export function encodeCheckpointCallData(): string {
  return SELECTOR_CHECKPOINT;
}

/** ABI-encode `claimTokens(uint256)`. */
export function encodeClaimTokens(bidId: bigint): string {
  return `0x${SELECTOR_CLAIM_TOKENS.slice(2)}${pad32(bidId)}`;
}

/** ABI-encode `claimTokensBatch(address,uint256[])` with non-empty ids. */
export function encodeClaimTokensBatch(
  owner: string,
  bidIds: bigint[],
): string {
  if (bidIds.length === 0)
    throw new Error("claim batch needs at least one bid id");
  const head =
    SELECTOR_CLAIM_TOKENS_BATCH.slice(2) + encodeAddress(owner) + pad32(0x40n); // offset of the dynamic array
  const tail = pad32(BigInt(bidIds.length)) + bidIds.map(pad32).join("");
  return `0x${head}${tail}`;
}

/**
 * ABI-encode `approve(address,address,uint160,uint48)` on Permit2 — the
 * allowance a USDC bid needs before `submitBid` (`permit2TransferFrom` pulls
 * `amount` from the sender). Amounts are capped at 2^160-1 and the deadline at
 * 2^48-1 by the calldata width; the caller should pass a sane deadline.
 */
export function encodePermit2Approve(
  token: string,
  spender: string,
  amount: bigint,
  deadline: bigint,
): string {
  return (
    "0x" +
    SELECTOR_PERMIT2_APPROVE.slice(2) +
    encodeAddress(token) +
    encodeAddress(spender) +
    pad32(amount) +
    pad32(deadline)
  );
}

/** Convenience: the full unsigned tx for a bid on an ERC-20-currency auction. */
export function buildBidTransaction(
  auctionAddress: string,
  plan: BidPlan,
): UnsignedTx {
  return { to: auctionAddress, value: "0x0", data: encodeSubmitBid(plan) };
}

/**
 * Compose the full ordered call list of a bid: the Permit2 approval
 * (ERC-20-currency auctions) followed by `submitBid`. This is THE composer
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
 * (Native-currency auctions are unchanged from the old inline composition:
 * `value` stays "0x0" — only the ERC-20 path is wired.)
 */
export function buildBidCalls(input: {
  auction: string;
  plan: BidPlan;
  /** ERC-20 currency address, or null/other for a non-ERC-20 auction. */
  currency: string | null;
  /** Permit2 approval deadline (unix seconds). */
  deadline: bigint;
}): UnsignedTx[] {
  const calls: UnsignedTx[] = [];
  const currency = input.currency;
  if (currency && /^0x[0-9a-fA-F]{40}$/.test(currency)) {
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
  calls.push(buildBidTransaction(input.auction, input.plan));
  return calls;
}

/**
 * A bid plan whose previous-tick hint defaults to the launch's own floor price
 * (the auction's first initialized tick) unless the caller supplies a better
 * one. Passing the launch floor is what the 4-arg `submitBid` overload does
 * onchain, and it is always valid.
 */
export function bidPlanWithDefaultHint(
  plan: Omit<BidPlan, "prevTickPriceQ96">,
  floorPriceQ96: bigint,
): BidPlan {
  return { ...plan, prevTickPriceQ96: floorPriceQ96 };
}

// Kept for parity with launch-params' decimal helpers: the auction amounts are
// currency smallest units; nothing in this module mints or moves value itself.
export const Q96_REFERENCE = Q96;
