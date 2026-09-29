/**
 * Pure calldata builders for the launchpad's in-app EVM transactions.
 *
 * Every builder returns **ordered unsigned calls**; signing and broadcasting
 * stay in the Tauri layer. Nothing here touches the network, the clock, or the
 * DOM — inputs in, bytes out — so the whole surface is deterministically
 * testable against `cast` golden vectors (`evmCalls.test.mjs`).
 *
 * Encoding is hand-rolled (fixed-width head words + dynamic tails) through the
 * small generic ABI encoder below: no wallet library, no ethers/viem. Function
 * selectors are derived with keccak-256 from the canonical signature strings
 * via `@noble/hashes` (already a desktop dependency) rather than pinned as hex
 * literals; the test suite cross-checks every derived selector against the
 * pinned values in `web/src/features/launchpad/lib/bid-tx.ts`,
 * `crates/buzz-cli/src/commands/launchpad_compose.rs`, and `cast sig`.
 *
 * Sources of truth for every layout:
 * - CCA bids/exits/claims: the vendored upstream interface
 *   `contracts/lib/continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol`
 *   (the full pinned surface) and `contracts/src/CCA.sol` (the handoff
 *   mirror). Golden vectors overlap `contracts/test/BidCalldata.t.sol` and the
 *   web suite `web/src/features/launchpad/lib/bid-tx.test.mjs`.
 * - Permit2: canonical `approve(address,address,uint160,uint48)` at the
 *   canonical Permit2 address.
 * - Token deploy: `contracts/script/DeployAppToken.s.sol` calling
 *   `tm-tokenmaster` — `contracts/lib/tm-tokenmaster/src/DataTypes.sol`
 *   (DeploymentParameters / PoolDeploymentParameters / SignatureECDSA),
 *   `src/interfaces/ITokenMasterRouter.sol` (`deployToken`),
 *   `src/pools/standard-token-pool/DataTypes.sol`
 *   (StandardPoolInitializationParameters et al.).
 * - Graduation: `contracts/src/GraduationExecutor.sol`
 *   (`executeGraduation(address)`).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Canonical Permit2 (used by every CCA deployment for currency pulls). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** The TokenMaster router `DeployAppToken.s.sol` defaults to (APPTOKEN_ROUTER). */
export const DEFAULT_TOKENMASTER_ROUTER =
  "0x0E00009d00d1000069ed00A908e00081F5006008";

/**
 * The StandardPool factory `DeployAppToken.s.sol` defaults to
 * (APPTOKEN_STANDARD_FACTORY).
 */
export const DEFAULT_STANDARD_POOL_FACTORY =
  "0x000000c5F2DF717F497BeAcCE161F8b042310d17";

/**
 * The canonical creator-token Transfer Validator the deploy script wires when
 * APPTOKEN_TV is unset (`DeployAppToken.s.sol`, `realTV`).
 */
export const CANONICAL_TRANSFER_VALIDATOR =
  "0x721C008fdff27BF06E7E123956E2Fe03B63342e3";

/** The zero address — native pairing / "no validator yet" marker. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Generic ABI encoder (the subset of types the launchpad calls need)
// ---------------------------------------------------------------------------

/**
 * The ABI types this encoder supports. Tuples mirror Solidity structs and
 * arrays mirror dynamic arrays; static tuples containing a dynamic member
 * (string/bytes/array/tuple) become dynamic, per the ABI spec.
 */
export type AbiType =
  | "address"
  | "bool"
  | "bytes32"
  | "bytes"
  | "string"
  | `uint${number}`
  | { tuple: readonly AbiType[] }
  | { array: AbiType };

/** Values accepted by {@link encodeParameters}: bigint, bool, string, tuple. */
export type AbiValue = bigint | boolean | string | readonly AbiValue[];

const HEX_RE = /^[0-9a-f]*$/;
const ADDRESS_RE = /^[0-9a-f]{40}$/;

function word(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** Normalize a 0x-or-bare hex address to its 32-byte ABI word. */
function addressWord(a: string): string {
  const h = a.toLowerCase().replace(/^0x/, "");
  if (!ADDRESS_RE.test(h)) throw new Error(`invalid address: ${a}`);
  return word(BigInt(`0x${h}`));
}

/** Normalize a 0x-or-bare hex string to bare lowercase hex. */
function bareHex(hex: string, label: string): string {
  const h = hex.replace(/^0x/, "").toLowerCase();
  if (h.length % 2 !== 0 || !HEX_RE.test(h))
    throw new Error(`${label} must be even-length hex`);
  return h;
}

function uintWord(value: bigint, bits: number): string {
  if (bits <= 0 || bits > 256 || bits % 8 !== 0)
    throw new Error(`unsupported uint width: ${bits}`);
  if (typeof value !== "bigint") throw new Error("uint values must be bigint");
  if (value < 0n || value >= 1n << BigInt(bits))
    throw new Error(`uint${bits} out of range: ${value}`);
  return word(value);
}

function isDynamicType(t: AbiType): boolean {
  if (t === "bytes" || t === "string") return true;
  if (typeof t === "object") {
    if ("array" in t) return true;
    return t.tuple.some(isDynamicType);
  }
  return false;
}

/** Total words a static type occupies in-place (only called for static types). */
function staticWords(t: AbiType): number {
  if (typeof t === "object" && "tuple" in t)
    return t.tuple.reduce((n, c) => n + staticWords(c), 0);
  return 1;
}

/** Words a type occupies in its enclosing head (1 for dynamic types: offset). */
function headWords(t: AbiType): number {
  return isDynamicType(t) ? 1 : staticWords(t);
}

interface EncodedValue {
  /** In-place words; empty for dynamic types (the caller writes the offset). */
  head: string;
  /** Out-of-line block; empty for static types. */
  tail: string;
}

function encodeValue(t: AbiType, v: AbiValue): EncodedValue {
  if (typeof t === "object") {
    if ("tuple" in t) {
      if (!Array.isArray(v)) throw new Error("tuple value must be an array");
      const body = encodeArgsBlock(t.tuple, v);
      return isDynamicType(t)
        ? { head: "", tail: body }
        : { head: body, tail: "" };
    }
    if ("array" in t) {
      if (!Array.isArray(v)) throw new Error("array value must be an array");
      // Dynamic-array tail: length word + elements block. Element offsets (for
      // dynamic element types) are relative to the start of the elements block.
      const elements = encodeArgsBlock(
        v.map(() => t.array),
        v,
      );
      return { head: "", tail: word(BigInt(v.length)) + elements };
    }
    throw new Error("unsupported ABI type");
  }
  switch (t) {
    case "bool": {
      if (typeof v !== "boolean") throw new Error("bool value must be boolean");
      return { head: word(v ? 1n : 0n), tail: "" };
    }
    case "address": {
      if (typeof v !== "string")
        throw new Error("address value must be string");
      return { head: addressWord(v), tail: "" };
    }
    case "bytes32": {
      if (typeof v !== "string")
        throw new Error("bytes32 value must be string");
      const h = bareHex(v, "bytes32");
      if (h.length !== 64) throw new Error("bytes32 must be 32 bytes");
      return { head: h, tail: "" };
    }
    case "bytes": {
      if (typeof v !== "string") throw new Error("bytes value must be string");
      const h = bareHex(v, "bytes");
      const padded = h.padEnd(Math.ceil(h.length / 64) * 64, "0");
      return { head: "", tail: word(BigInt(h.length / 2)) + padded };
    }
    case "string": {
      if (typeof v !== "string") throw new Error("string value must be string");
      const h = bytesToHex(new TextEncoder().encode(v));
      const padded = h.padEnd(Math.ceil(h.length / 64) * 64, "0");
      return { head: "", tail: word(BigInt(h.length / 2)) + padded };
    }
    default: {
      const m = /^uint(\d+)$/.exec(t);
      if (!m) throw new Error(`unsupported ABI type: ${t}`);
      if (typeof v !== "bigint") throw new Error(`${t} value must be bigint`);
      return { head: uintWord(v, Number(m[1])), tail: "" };
    }
  }
}

/**
 * The canonical head-with-offsets + tails layout of a tuple (and of a
 * function's argument block, which the ABI treats as an anonymous tuple).
 * Offsets are relative to the start of this block.
 */
function encodeArgsBlock(
  types: readonly AbiType[],
  values: readonly AbiValue[],
): string {
  if (types.length !== values.length)
    throw new Error(
      `ABI arity mismatch: ${types.length} types vs ${values.length} values`,
    );
  const heads: string[] = [];
  const tails: string[] = [];
  let headBytes = 0;
  for (const t of types) headBytes += headWords(t) * 32;
  let tailBytes = headBytes;
  for (let i = 0; i < types.length; i++) {
    const { head, tail } = encodeValue(types[i], values[i]);
    if (isDynamicType(types[i])) {
      heads.push(word(BigInt(tailBytes)));
      tails.push(tail);
      tailBytes += tail.length / 2;
    } else {
      heads.push(head);
    }
  }
  return heads.join("") + tails.join("");
}

/**
 * ABI-encode `values` as a function's argument block (no selector). Returns a
 * 0x-prefixed hex string. Types and values must line up positionally.
 */
export function encodeParameters(
  types: readonly AbiType[],
  values: readonly AbiValue[],
): string {
  return `0x${encodeArgsBlock(types, values)}`;
}

/**
 * keccak-256 first 4 bytes of a canonical function signature — the selector a
 * Solidity dispatcher matches on. Cross-check with `cast sig '<signature>'`.
 */
export function selectorOf(signature: string): string {
  const digest = keccak_256(new TextEncoder().encode(signature));
  return `0x${bytesToHex(digest.slice(0, 4))}`;
}

/** ABI-encode a full call: selector of `signature` + argument block. */
export function encodeFunctionData(
  signature: string,
  types: readonly AbiType[],
  values: readonly AbiValue[],
): string {
  return selectorOf(signature) + encodeParameters(types, values).slice(2);
}

// ---------------------------------------------------------------------------
// Canonical signatures and selectors (cross-checked with `cast sig`)
// ---------------------------------------------------------------------------

/** `submitBid(uint256,uint128,address,uint256,bytes)` — the 5-arg overload. */
export const SIGNATURE_SUBMIT_BID =
  "submitBid(uint256,uint128,address,uint256,bytes)";
/** `exitBid(uint256)` — full refund of a bid priced above the final clearing. */
export const SIGNATURE_EXIT_BID = "exitBid(uint256)";
/**
 * `exitPartiallyFilledBid(uint256,uint64,uint64)` — refund the unfilled share
 * of a partially filled bid (vendored `IContinuousClearingAuction`: `exitBid`
 * is for fully filled bids only).
 */
export const SIGNATURE_EXIT_PARTIALLY_FILLED_BID =
  "exitPartiallyFilledBid(uint256,uint64,uint64)";
/** `claimTokens(uint256)` — claim the filled share after the claim block. */
export const SIGNATURE_CLAIM_TOKENS = "claimTokens(uint256)";
/** `claimTokensBatch(address,uint256[])` — claim several bids of one owner. */
export const SIGNATURE_CLAIM_TOKENS_BATCH =
  "claimTokensBatch(address,uint256[])";
/** `approve(address,address,uint160,uint48)` — Permit2 allowance for a spender. */
export const SIGNATURE_PERMIT2_APPROVE =
  "approve(address,address,uint160,uint48)";
/** `approve(address,uint256)` — standard ERC-20 allowance. */
export const SIGNATURE_ERC20_APPROVE = "approve(address,uint256)";
/** `setTransferValidator(address)` — ERC-20C owner op on the new token. */
export const SIGNATURE_SET_TRANSFER_VALIDATOR = "setTransferValidator(address)";
/** `setRulesetOfCollection(address,uint8,address,uint8,uint16)` — TV ruleset. */
export const SIGNATURE_SET_RULESET_OF_COLLECTION =
  "setRulesetOfCollection(address,uint8,address,uint8,uint16)";
/**
 * `deployToken(...)` — TokenMaster router entry point
 * (`ITokenMasterRouter.deployToken(DeploymentParameters,SignatureECDSA)`).
 * Tuple types follow `tm-tokenmaster/src/DataTypes.sol` field order exactly.
 */
export const SIGNATURE_DEPLOY_TOKEN =
  "deployToken((address,bytes32,address,bool,bool," +
  "(string,string,uint8,address,address,uint256,bytes,address,bool,address,uint256),uint16)," +
  "(uint256,bytes32,bytes32))";
/** `executeGraduation(address)` — GraduationExecutor's atomic sweep handoff. */
export const SIGNATURE_EXECUTE_GRADUATION = "executeGraduation(address)";
/** ERC-20 `transfer(address,uint256)` — moves the sale supply into the auction. */
export const SIGNATURE_ERC20_TRANSFER = "transfer(address,uint256)";
/** ERC-20 `balanceOf(address)` — the funding preflight/idempotency read. */
export const SIGNATURE_ERC20_BALANCE_OF = "balanceOf(address)";
/** `onTokensReceived()` on the CCA — arms the auction once its supply arrived. */
export const SIGNATURE_ON_TOKENS_RECEIVED = "onTokensReceived()";
/** `bindAuction(address)` on GraduationExecutor — the one-shot, treasury-only bind. */
export const SIGNATURE_BIND_AUCTION = "bindAuction(address)";
/** `boundAuction()` on GraduationExecutor — the bind idempotency read. */
export const SIGNATURE_BOUND_AUCTION = "boundAuction()";
/** `setAuction(address)` on AllowlistHook — the one-shot, owner-only bind. */
export const SIGNATURE_SET_HOOK_AUCTION = "setAuction(address)";
/** `auction()` on AllowlistHook — the bind idempotency read. */
export const SIGNATURE_HOOK_AUCTION = "auction()";
/** `withdrawStuckReserve(address)` — treasury takes an unreleased reserve back after the lock. */
export const SIGNATURE_WITHDRAW_STUCK_RESERVE = "withdrawStuckReserve(address)";

/** Selector of {@link SIGNATURE_SUBMIT_BID} (web pin: `0xa52c8728`). */
export const SELECTOR_SUBMIT_BID = selectorOf(SIGNATURE_SUBMIT_BID);
/** Selector of {@link SIGNATURE_EXIT_BID} (web pin: `0x8e4deb17`). */
export const SELECTOR_EXIT_BID = selectorOf(SIGNATURE_EXIT_BID);
/** Selector of {@link SIGNATURE_EXIT_PARTIALLY_FILLED_BID} (`cast`: `0x36dec5f2`). */
export const SELECTOR_EXIT_PARTIALLY_FILLED_BID = selectorOf(
  SIGNATURE_EXIT_PARTIALLY_FILLED_BID,
);
/** Selector of {@link SIGNATURE_CLAIM_TOKENS} (web pin: `0x46e04a2f`). */
export const SELECTOR_CLAIM_TOKENS = selectorOf(SIGNATURE_CLAIM_TOKENS);
/** Selector of {@link SIGNATURE_CLAIM_TOKENS_BATCH} (web pin: `0xb8f163d6`). */
export const SELECTOR_CLAIM_TOKENS_BATCH = selectorOf(
  SIGNATURE_CLAIM_TOKENS_BATCH,
);
/** Selector of {@link SIGNATURE_PERMIT2_APPROVE} (web pin: `0x87517c45`). */
export const SELECTOR_PERMIT2_APPROVE = selectorOf(SIGNATURE_PERMIT2_APPROVE);
/** Selector of {@link SIGNATURE_ERC20_APPROVE} (`cast`: `0x095ea7b3`). */
export const SELECTOR_ERC20_APPROVE = selectorOf(SIGNATURE_ERC20_APPROVE);
/** Selector of {@link SIGNATURE_SET_TRANSFER_VALIDATOR} (`cast`: `0xa9fc664e`). */
export const SELECTOR_SET_TRANSFER_VALIDATOR = selectorOf(
  SIGNATURE_SET_TRANSFER_VALIDATOR,
);
/** Selector of {@link SIGNATURE_SET_RULESET_OF_COLLECTION} (`cast`: `0xbc8aa284`). */
export const SELECTOR_SET_RULESET_OF_COLLECTION = selectorOf(
  SIGNATURE_SET_RULESET_OF_COLLECTION,
);
/** Selector of {@link SIGNATURE_DEPLOY_TOKEN} (`cast`: `0xa29f4a56`). */
export const SELECTOR_DEPLOY_TOKEN = selectorOf(SIGNATURE_DEPLOY_TOKEN);
/** Selector of {@link SIGNATURE_EXECUTE_GRADUATION} (`cast`: `0x69d4d0f1`). */
export const SELECTOR_EXECUTE_GRADUATION = selectorOf(
  SIGNATURE_EXECUTE_GRADUATION,
);
/** Selector of {@link SIGNATURE_ERC20_TRANSFER} (`cast`: `0xa9059cbb`). */
export const SELECTOR_ERC20_TRANSFER = selectorOf(SIGNATURE_ERC20_TRANSFER);
/** Selector of {@link SIGNATURE_ERC20_BALANCE_OF} (`cast`: `0x70a08231`). */
export const SELECTOR_ERC20_BALANCE_OF = selectorOf(SIGNATURE_ERC20_BALANCE_OF);
/** Selector of {@link SIGNATURE_ON_TOKENS_RECEIVED} (`cast`: `0x331f2f65`). */
export const SELECTOR_ON_TOKENS_RECEIVED = selectorOf(
  SIGNATURE_ON_TOKENS_RECEIVED,
);
/** Selector of {@link SIGNATURE_BIND_AUCTION} (`cast`: `0xccd616ae`). */
export const SELECTOR_BIND_AUCTION = selectorOf(SIGNATURE_BIND_AUCTION);
/** Selector of {@link SIGNATURE_BOUND_AUCTION} (`cast`: `0x769956cb`). */
export const SELECTOR_BOUND_AUCTION = selectorOf(SIGNATURE_BOUND_AUCTION);
/** Selector of {@link SIGNATURE_SET_HOOK_AUCTION} (`cast`: `0xb8c6f579`). */
export const SELECTOR_SET_HOOK_AUCTION = selectorOf(SIGNATURE_SET_HOOK_AUCTION);
/** Selector of {@link SIGNATURE_HOOK_AUCTION} (`cast`: `0x7d9f6db5`). */
export const SELECTOR_HOOK_AUCTION = selectorOf(SIGNATURE_HOOK_AUCTION);
/** Selector of {@link SIGNATURE_WITHDRAW_STUCK_RESERVE} (`cast`: `0xeb6ba94e`). */
export const SELECTOR_WITHDRAW_STUCK_RESERVE = selectorOf(
  SIGNATURE_WITHDRAW_STUCK_RESERVE,
);

// ---------------------------------------------------------------------------
// Call shape
// ---------------------------------------------------------------------------

/**
 * One unsigned contract call. `value` is a hex quantity — builders always
 * populate it ("0x0" when the call moves no native value) so the signing layer
 * never has to guess.
 */
export interface EvmCall {
  to: string;
  data: string;
  value?: string;
}

/** Hex quantity for a call's native value ("0x0" for zero, no leading zeros). */
function valueHex(n: bigint): string {
  return `0x${n.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Bid / exit / claim — CCA auction calls
// (port of web/src/features/launchpad/lib/bid-tx.ts)
// ---------------------------------------------------------------------------

/** A bid on a CCA auction, mirroring web's `BidPlan` field for field. */
export interface BidPlan {
  /** Max Q96 price the bidder accepts; must sit on the auction's tick grid. */
  maxPriceQ96: bigint;
  /** Bid budget in currency smallest units (USDC 6 decimals). */
  amount: bigint;
  /** The bidder receiving tokens and refunds. `address(0)` reverts onchain. */
  owner: string;
  /** Gas hint: Q96 price of the nearest initialized tick below maxPrice. */
  prevTickPriceQ96: bigint;
  hookData: string;
}

/**
 * A bid plan whose previous-tick hint defaults to the launch's own floor price
 * (the auction's first initialized tick) unless the caller supplies a better
 * one. Port of web's `bidPlanWithDefaultHint`.
 */
export function bidPlanWithDefaultHint(
  plan: Omit<BidPlan, "prevTickPriceQ96">,
  floorPriceQ96: bigint,
): BidPlan {
  return { ...plan, prevTickPriceQ96: floorPriceQ96 };
}

const SUBMIT_BID_TYPES: readonly AbiType[] = [
  "uint256", // maxPriceQ96
  "uint128", // amount
  "address", // owner
  "uint256", // prevTickPriceQ96
  "bytes", // hookData (the one dynamic tail)
];

/** ABI-encode `submitBid(uint256,uint128,address,uint256,bytes)`. */
export function encodeSubmitBid(plan: BidPlan): string {
  return encodeFunctionData(SIGNATURE_SUBMIT_BID, SUBMIT_BID_TYPES, [
    plan.maxPriceQ96,
    plan.amount,
    plan.owner,
    plan.prevTickPriceQ96,
    plan.hookData,
  ]);
}

/** ABI-encode `exitBid(uint256)`. */
export function encodeExitBid(bidId: bigint): string {
  return encodeFunctionData(SIGNATURE_EXIT_BID, ["uint256"], [bidId]);
}

/**
 * ABI-encode `exitPartiallyFilledBid(uint256,uint64,uint64)`. The two block
 * numbers come from the bid's fill history (the contract requires them to
 * bound its checkpoint walk); both fit uint64.
 */
export function encodeExitPartiallyFilledBid(
  bidId: bigint,
  lastFullyFilledCheckpointBlock: bigint,
  outbidBlock: bigint,
): string {
  return encodeFunctionData(
    SIGNATURE_EXIT_PARTIALLY_FILLED_BID,
    ["uint256", "uint64", "uint64"],
    [bidId, lastFullyFilledCheckpointBlock, outbidBlock],
  );
}

/** ABI-encode `claimTokens(uint256)`. */
export function encodeClaimTokens(bidId: bigint): string {
  return encodeFunctionData(SIGNATURE_CLAIM_TOKENS, ["uint256"], [bidId]);
}

/** ABI-encode `claimTokensBatch(address,uint256[])` with non-empty ids. */
export function encodeClaimTokensBatch(
  owner: string,
  bidIds: readonly bigint[],
): string {
  if (bidIds.length === 0)
    throw new Error("claim batch needs at least one bid id");
  return encodeFunctionData(
    SIGNATURE_CLAIM_TOKENS_BATCH,
    ["address", { array: "uint256" }],
    [owner, bidIds],
  );
}

/**
 * ABI-encode `approve(address,address,uint160,uint48)` on Permit2 — the
 * allowance a bid needs before `submitBid` (`permit2TransferFrom` pulls
 * `amount` from the sender). Amounts are capped at 2^160-1 and the deadline at
 * 2^48-1 by the calldata width; the caller should pass a sane deadline.
 */
export function encodePermit2Approve(
  token: string,
  spender: string,
  amount: bigint,
  deadline: bigint,
): string {
  return encodeFunctionData(
    SIGNATURE_PERMIT2_APPROVE,
    ["address", "address", "uint160", "uint48"],
    [token, spender, amount, deadline],
  );
}

/**
 * ABI-encode the standard ERC-20 `approve(address,uint256)`. Used to grant
 * Permit2 its underlying-token allowance — the step the web flow omits and a
 * first-time bidder's `permit2TransferFrom` reverts without.
 */
export function encodeErc20Approve(spender: string, amount: bigint): string {
  return encodeFunctionData(
    SIGNATURE_ERC20_APPROVE,
    ["address", "uint256"],
    [spender, amount],
  );
}

/** Inputs for {@link buildBidCalls}. */
export interface BidCallsParams {
  /** CCA auction address. */
  auction: string;
  /**
   * Bid currency. The zero address marks a native-currency auction: no
   * allowance calls, and the bid call carries the budget as `msg.value` (the
   * vendored CCA enforces `msg.value == amount` for native bids and
   * `msg.value == 0` for ERC-20 bids).
   */
  currency: string;
  plan: BidPlan;
  /**
   * True when the bidder's underlying ERC-20 → Permit2 allowance is missing
   * or below the budget (first-time bidder). Prepends
   * `currency.approve(PERMIT2, amount)`; without that underlying approval
   * Permit2's `permit2TransferFrom` reverts even with a Permit2 allowance set.
   * The web flow (`web/src/features/launchpad/ui/RecordBidDialog.tsx`) omits
   * this step — that gap is fixed here. Ignored for native-currency auctions.
   */
  needsUnderlyingAllowance: boolean;
  /**
   * Unix-seconds deadline for the Permit2 approve (the web flow uses
   * now + 3600). Ignored for native-currency auctions.
   */
  permit2Deadline: bigint;
}

/**
 * Compose the ordered unsigned calls for one ERC-20-or-native bid:
 *
 * 1. (optional) `currency.approve(PERMIT2, amount)` — underlying ERC-20 →
 *    Permit2 allowance; only when `needsUnderlyingAllowance` (first-time
 *    bidder). Otherwise `permit2TransferFrom` reverts with TRANSFER_FROM_FAILED.
 * 2. (ERC-20 only) `PERMIT2.approve(currency, auction, amount, deadline)` —
 *    the Permit2 → auction spender allowance `submitBid` pulls through. The
 *    web flow re-emits this per bid; Permit2 approve is last-writer-wins and
 *    deadline-bounded, so re-emitting is idempotent.
 * 3. `auction.submitBid(maxPriceQ96, amount, owner, prevTickPriceQ96, hookData)`
 *    — the bid itself. Carries `value = amount` for native auctions and
 *    `value = 0` for ERC-20 ones.
 *
 * The signing layer broadcasts the calls in order (one batch to the wallet /
 * bundler); each call is a separate transaction-level commitment.
 */
export function buildBidCalls(params: BidCallsParams): EvmCall[] {
  const { auction, currency, plan, needsUnderlyingAllowance, permit2Deadline } =
    params;
  const isNative =
    currency.toLowerCase().replace(/^0x/, "") === ZERO_ADDRESS.slice(2);
  const calls: EvmCall[] = [];
  if (!isNative) {
    if (needsUnderlyingAllowance) {
      calls.push({
        to: currency,
        data: encodeErc20Approve(PERMIT2_ADDRESS, plan.amount),
        value: valueHex(0n),
      });
    }
    calls.push({
      to: PERMIT2_ADDRESS,
      data: encodePermit2Approve(
        currency,
        auction,
        plan.amount,
        permit2Deadline,
      ),
      value: valueHex(0n),
    });
  }
  calls.push({
    to: auction,
    data: encodeSubmitBid(plan),
    value: valueHex(isNative ? plan.amount : 0n),
  });
  return calls;
}

/** The single `auction.exitBid(bidId)` call (fully filled bids). */
export function buildExitBidCall(auction: string, bidId: bigint): EvmCall {
  return { to: auction, data: encodeExitBid(bidId), value: valueHex(0n) };
}

/**
 * The single `auction.exitPartiallyFilledBid(bidId, lastFullyFilledCheckpointBlock,
 * outbidBlock)` call — refunds the unfilled share of a partially filled bid.
 * The block pair must match the bid's onchain fill history; the contract
 * rejects stale hints.
 */
export function buildExitPartiallyFilledBidCall(
  auction: string,
  bidId: bigint,
  lastFullyFilledCheckpointBlock: bigint,
  outbidBlock: bigint,
): EvmCall {
  return {
    to: auction,
    data: encodeExitPartiallyFilledBid(
      bidId,
      lastFullyFilledCheckpointBlock,
      outbidBlock,
    ),
    value: valueHex(0n),
  };
}

/** The single `auction.claimTokens(bidId)` call. */
export function buildClaimTokensCall(auction: string, bidId: bigint): EvmCall {
  return { to: auction, data: encodeClaimTokens(bidId), value: valueHex(0n) };
}

/**
 * The single `auction.claimTokensBatch(owner, bidIds)` call. Throws on an
 * empty batch (mirrors web's encoder) — an empty onchain batch would revert or
 * no-op at gas cost anyway.
 */
export function buildClaimTokensBatchCall(
  auction: string,
  owner: string,
  bidIds: readonly bigint[],
): EvmCall {
  return {
    to: auction,
    data: encodeClaimTokensBatch(owner, bidIds),
    value: valueHex(0n),
  };
}

// ---------------------------------------------------------------------------
// Token deploy — mirror of contracts/script/DeployAppToken.s.sol
// ---------------------------------------------------------------------------

/** Inputs for {@link buildTokenDeployCalls} / {@link encodeDeployToken}. */
export interface TokenDeployCallsParams {
  /** Token name (`PoolDeploymentParameters.name`). */
  name: string;
  /** Token symbol (`PoolDeploymentParameters.symbol`). */
  symbol: string;
  /**
   * APPTOKEN_TREASURY — token `initialOwner` AND `initialSupplyRecipient`.
   * The deploy script requires broadcaster == treasury (the validator wiring
   * is an owner op); the signing account must be this address.
   */
  treasury: string;
  /**
   * The precomputed deterministic token address — `tokenAddress` in
   * `DeploymentParameters`. The script derives it from
   * `StandardPoolFactory.computeDeploymentAddress(bytes32(salt), poolParams,
   * pairedDeposit, router.infrastructureFeeBPS())`; both of those are view
   * calls, not transactions, so the caller supplies the result here.
   */
  tokenAddress: string;
  /** APPTOKEN_SALT → `bytes32(tokenSalt)`. Default 1n (the script default). */
  salt?: bigint;
  /**
   * Initial supply in base units (18 decimals). The script computes
   * `APPTOKEN_INITIAL_SUPPLY * 1e18`; pass the product. Default 1_000_000e18.
   */
  initialSupplyAmount?: bigint;
  /**
   * APPTOKEN_PAIRED_DEPOSIT_WEI — the native starting reserve, sent as
   * `msg.value` with `deployToken` (native pairing requires it to be nonzero).
   * Default 0.1 ether.
   */
  pairedDepositWei?: bigint;
  /** APPTOKEN_SPREAD_BPS — initial buy+sell spread. Default 100. */
  spreadBps?: number;
  /** APPTOKEN_BUY_FEE_BPS — initial buy fee. Default 200. */
  buyFeeBps?: number;
  /** APPTOKEN_SELL_FEE_BPS — initial sell fee. Default 200. */
  sellFeeBps?: number;
  /**
   * APPTOKEN_TV — `poolParams.defaultTransferValidator`, exactly as the script
   * passes it (may be the zero address = no validator at construction so the
   * initial mint is open). The post-deploy wiring resolves the zero address to
   * {@link CANONICAL_TRANSFER_VALIDATOR}, mirroring the script's `realTV`.
   */
  defaultTransferValidator?: string;
  /**
   * APPTOKEN_ROUTER — TokenMaster router. Default
   * {@link DEFAULT_TOKENMASTER_ROUTER}. Only affects each call's `to`.
   */
  router?: string;
  /** APPTOKEN_STANDARD_FACTORY. Default {@link DEFAULT_STANDARD_POOL_FACTORY}. */
  factory?: string;
  /**
   * APPTOKEN_OWNER — `poolParams.initialOwner`, the holder of the token's fee
   * and spread levers (below the immutable ceilings). Defaults to `treasury`.
   * Pass the DAO to launch DAO-owned. The transfer-validator wiring (calls 2-3
   * of {@link buildTokenDeployCalls}) is an OWNER op, so those calls are only
   * composed when the owner is the treasury wallet that signs; a different
   * owner wires the validator itself. To hand a treasury-owned token to the DAO
   * after graduation use {@link buildTransferTokenOwnershipCall}.
   */
  owner?: string;
}

interface ResolvedTokenDeployParams {
  name: string;
  symbol: string;
  treasury: string;
  owner: string;
  tokenAddress: string;
  salt: bigint;
  initialSupplyAmount: bigint;
  pairedDepositWei: bigint;
  spreadBps: number;
  buyFeeBps: number;
  sellFeeBps: number;
  defaultTransferValidator: string;
  router: string;
  factory: string;
}

/**
 * Immutable pool ceilings (docs/dao-os.md R4), mirrored from
 * `contracts/script/DeployAppToken.s.sol` and pinned by `evmCalls.test.mjs`.
 * They used to be 10_000 / 9999 bps — "the owner may charge a 100% fee" — a
 * rug-capable configuration owned by the treasury. Whoever owns the token can
 * move fees and spreads anywhere BELOW these, never above.
 */
export const MAX_TOKEN_FEE_BPS = 1_000n;
export const MAX_TOKEN_SPREAD_BPS = 1_000n;
/** Ceiling on the creator's share of spent value: equal to its initial value, so it can only go down. */
export const MAX_SPEND_CREATOR_SHARE_BPS = 5_000n;
export const INITIAL_SPEND_CREATOR_SHARE_BPS = 5_000n;

const TOKEN_DECIMALS = 18n; // the script hardcodes 18
const MAX_INFRASTRUCTURE_FEE_BPS = 250n; // deployParams.maxInfrastructureFeeBPS
const VANILLA_RULESET_ID = 1n; // open trading; tighten later via the validator

function resolveTokenDeployParams(
  params: TokenDeployCallsParams,
): ResolvedTokenDeployParams {
  const spreadBps = params.spreadBps ?? 100;
  const buyFeeBps = params.buyFeeBps ?? 200;
  const sellFeeBps = params.sellFeeBps ?? 200;
  // The script refuses these too (`AboveCeiling`): fail here, not on chain.
  for (const [label, value, ceiling] of [
    ["spreadBps", spreadBps, MAX_TOKEN_SPREAD_BPS],
    ["buyFeeBps", buyFeeBps, MAX_TOKEN_FEE_BPS],
    ["sellFeeBps", sellFeeBps, MAX_TOKEN_FEE_BPS],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || BigInt(value) > ceiling) {
      throw new Error(
        `${label} must be an integer in 0..${ceiling} (the pool's immutable ceiling): ${value}`,
      );
    }
  }
  return {
    name: params.name,
    symbol: params.symbol,
    treasury: params.treasury,
    owner: params.owner ?? params.treasury,
    tokenAddress: params.tokenAddress,
    salt: params.salt ?? 1n,
    initialSupplyAmount: params.initialSupplyAmount ?? 1_000_000n * 10n ** 18n,
    pairedDepositWei: params.pairedDepositWei ?? 10n ** 17n, // 0.1 ether
    spreadBps,
    buyFeeBps,
    sellFeeBps,
    defaultTransferValidator: params.defaultTransferValidator ?? ZERO_ADDRESS,
    router: params.router ?? DEFAULT_TOKENMASTER_ROUTER,
    factory: params.factory ?? DEFAULT_STANDARD_POOL_FACTORY,
  };
}

/**
 * `DeploymentParameters.poolParams.encodedInitializationArgs` — the script's
 * `abi.encode(StandardPoolInitializationParameters{...})`: treasury gets
 * `initialSupplyAmount - 1` while the router keeps a permanent 1-wei lock
 * (`contracts/lib/tm-tokenmaster/src/pools/standard-token-pool/StandardPool.sol:127-128`),
 * spread/fees come from params, emission is off, spend
 * shares 50/50 creator/market, nothing paused, and the buy-cost ratio is
 * 1e18/1e18. All fields are static, so the encoding is 28 flat words.
 * Field order: `pools/standard-token-pool/DataTypes.sol`.
 */
function encodeStandardPoolInitArgs(p: ResolvedTokenDeployParams): string {
  const buyParams: AbiValue = [
    BigInt(p.spreadBps), // buySpreadBPS
    BigInt(p.buyFeeBps), // buyFeeBPS
    10n ** 18n, // buyCostPairedTokenNumerator
    10n ** 18n, // buyCostPoolTokenDenominator
    false, // useTargetSupply
    0n, // reserved
    0n, // buyDemandFeeBPS
    0n, // targetSupplyBaseline
    0n, // targetSupplyBaselineScaleFactor
    0n, // targetSupplyGrowthRatePerSecond
    0n, // targetSupplyBaselineTimestamp
  ];
  const sellParams: AbiValue = [
    BigInt(p.spreadBps), // sellSpreadBPS
    BigInt(p.sellFeeBps), // sellFeeBPS
  ];
  const spendParams: AbiValue = [INITIAL_SPEND_CREATOR_SHARE_BPS]; // creatorShareBPS — script's 5000
  return encodeParameters(
    [
      {
        tuple: [
          "address", // initialSupplyRecipient
          "uint256", // initialSupplyAmount
          "uint256", // minBuySpreadBPS
          "uint256", // maxBuySpreadBPS
          "uint256", // maxBuyFeeBPS
          "uint256", // maxBuyDemandFeeBPS
          "uint256", // minSellSpreadBPS
          "uint256", // maxSellSpreadBPS
          "uint256", // maxSellFeeBPS
          "uint256", // maxSpendCreatorShareBPS
          "uint256", // creatorEmissionRateNumerator
          "uint256", // creatorEmissionRateDenominator
          "uint256", // creatorEmissionsHardCap
          {
            tuple: [
              "uint16", // buySpreadBPS
              "uint16", // buyFeeBPS
              "uint96", // buyCostPairedTokenNumerator
              "uint96", // buyCostPoolTokenDenominator
              "bool", // useTargetSupply
              "uint24", // reserved
              "uint16", // buyDemandFeeBPS
              "uint48", // targetSupplyBaseline
              "uint8", // targetSupplyBaselineScaleFactor
              "uint96", // targetSupplyGrowthRatePerSecond
              "uint48", // targetSupplyBaselineTimestamp
            ],
          }, // initialBuyParameters
          { tuple: ["uint16", "uint16"] }, // initialSellParameters
          { tuple: ["uint16"] }, // initialSpendParameters
          "uint256", // initialPausedState
        ],
      },
    ],
    [
      [
        p.treasury, // initialSupplyRecipient
        p.initialSupplyAmount,
        0n, // minBuySpreadBPS
        MAX_TOKEN_SPREAD_BPS, // maxBuySpreadBPS
        MAX_TOKEN_FEE_BPS, // maxBuyFeeBPS
        MAX_TOKEN_FEE_BPS, // maxBuyDemandFeeBPS
        0n, // minSellSpreadBPS
        MAX_TOKEN_SPREAD_BPS, // maxSellSpreadBPS
        MAX_TOKEN_FEE_BPS, // maxSellFeeBPS
        MAX_SPEND_CREATOR_SHARE_BPS, // maxSpendCreatorShareBPS
        0n, // creatorEmissionRateNumerator
        1n, // creatorEmissionRateDenominator
        0n, // creatorEmissionsHardCap
        buyParams,
        sellParams,
        spendParams,
        0n, // initialPausedState
      ],
    ],
  );
}

/**
 * ABI-encode `router.deployToken{value: pairedDepositWei}(deployParams,
 * SignatureECDSA({v: 0, r: 0, s: 0}))` — the deploy script's one router call.
 * The empty signature matches the script (permissionless on fresh/local
 * deployments). Struct field order: `tm-tokenmaster/src/DataTypes.sol`.
 */
export function encodeDeployToken(params: TokenDeployCallsParams): string {
  const p = resolveTokenDeployParams(params);
  return encodeFunctionData(
    SIGNATURE_DEPLOY_TOKEN,
    [
      {
        tuple: [
          "address", // tokenFactory
          "bytes32", // tokenSalt
          "address", // tokenAddress
          "bool", // blockTransactionsFromUntrustedChannels
          "bool", // restrictPairingToLists
          {
            tuple: [
              "string", // name
              "string", // symbol
              "uint8", // tokenDecimals
              "address", // initialOwner
              "address", // pairedToken
              "uint256", // initialPairedTokenToDeposit
              "bytes", // encodedInitializationArgs
              "address", // defaultTransferValidator
              "bool", // useRouterForPairedTransfers
              "address", // partnerFeeRecipient
              "uint256", // partnerFeeBPS
            ],
          }, // poolParams
          "uint16", // maxInfrastructureFeeBPS
        ],
      }, // DeploymentParameters
      { tuple: ["uint256", "bytes32", "bytes32"] }, // SignatureECDSA
    ],
    [
      [
        p.factory, // tokenFactory
        `0x${p.salt.toString(16).padStart(64, "0")}`, // bytes32(tokenSalt)
        p.tokenAddress,
        false, // blockTransactionsFromUntrustedChannels
        false, // restrictPairingToLists
        [
          p.name,
          p.symbol,
          TOKEN_DECIMALS, // tokenDecimals — the script hardcodes 18
          p.owner, // initialOwner (APPTOKEN_OWNER, default the treasury)
          ZERO_ADDRESS, // pairedToken — native pairing
          p.pairedDepositWei, // initialPairedTokenToDeposit
          encodeStandardPoolInitArgs(p), // encodedInitializationArgs
          p.defaultTransferValidator,
          false, // useRouterForPairedTransfers
          ZERO_ADDRESS, // partnerFeeRecipient
          0n, // partnerFeeBPS
        ],
        MAX_INFRASTRUCTURE_FEE_BPS,
      ],
      [0n, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`], // empty signature
    ],
  );
}

/** ABI-encode `token.setTransferValidator(validator)` (ERC-20C owner op). */
export function encodeSetTransferValidator(validator: string): string {
  return encodeFunctionData(
    SIGNATURE_SET_TRANSFER_VALIDATOR,
    ["address"],
    [validator],
  );
}

/**
 * ABI-encode `validator.setRulesetOfCollection(collection, rulesetId,
 * customRuleset, globalOptions, rulesetOptions)` (the deploy script's pinned
 * `IValidatorRuleset` surface).
 */
export function encodeSetRulesetOfCollection(
  collection: string,
  rulesetId: bigint,
  customRuleset: string,
  globalOptions: bigint,
  rulesetOptions: bigint,
): string {
  return encodeFunctionData(
    SIGNATURE_SET_RULESET_OF_COLLECTION,
    ["address", "uint8", "address", "uint8", "uint16"],
    [collection, rulesetId, customRuleset, globalOptions, rulesetOptions],
  );
}

/**
 * Compose the exact onchain call sequence of `DeployAppToken.s.sol`'s
 * broadcast section — a Standard-pool apptoken (ERC-20C, native pairing):
 *
 * 1. `router.deployToken{value: pairedDepositWei}(deployParams, empty
 *    signature)` — deploys the token + Standard pool via CREATE2 at
 *    `tokenAddress`, mints `initialSupplyAmount` to `treasury`, and deposits
 *    `pairedDepositWei` of native pairing as the pool's starting reserve.
 * 2. `token.setTransferValidator(realTV)` — wires the transfer validator on
 *    the new token. `realTV` resolves the zero address to
 *    {@link CANONICAL_TRANSFER_VALIDATOR} exactly like the script. Owner-only:
 *    the broadcaster must be `treasury`.
 * 3. `realTV.setRulesetOfCollection(token, 1, address(0), 0, 0)` — Vanilla
 *    ruleset (id 1 = open trading) on the validator. Tighten later via the
 *    validator itself.
 *
 * Behavior of the script that is NOT an onchain call (deliberately not
 * dropped, just not representable as a transaction):
 * - `router.infrastructureFeeBPS()` + `factory.computeDeploymentAddress(...)`
 *   are view calls used to precompute `tokenAddress`; the caller passes the
 *   result as {@link TokenDeployCallsParams.tokenAddress}.
 * - `emit AppTokenDeployed(token)` is a forge-script-side log ("script emits
 *   never land in broadcast receipts") with no onchain effect.
 * - `vm.writeFile("deployments/apptoken-latest.json", ...)` is the deploy-
 *   artifact JSON handoff the CLI parses — offchain bookkeeping owned by the
 *   deploy tooling, not by the signing layer.
 */
export function buildTokenDeployCalls(
  params: TokenDeployCallsParams,
): EvmCall[] {
  const p = resolveTokenDeployParams(params);
  // The script: `realTV = tv == address(0) ? 0x721C...42e3 : tv`.
  const realTransferValidator =
    p.defaultTransferValidator.toLowerCase() === ZERO_ADDRESS
      ? CANONICAL_TRANSFER_VALIDATOR
      : p.defaultTransferValidator;
  const deploy: EvmCall = {
    to: p.router,
    data: encodeDeployToken(params),
    value: valueHex(p.pairedDepositWei),
  };
  // Calls 2-3 are OWNER ops signed by the treasury wallet: when the token is
  // launched with a different owner (the DAO) they would revert, so the owner
  // wires the validator itself.
  if (p.owner.toLowerCase() !== p.treasury.toLowerCase()) return [deploy];
  return [
    deploy,
    {
      to: p.tokenAddress,
      data: encodeSetTransferValidator(realTransferValidator),
      value: valueHex(0n),
    },
    {
      to: realTransferValidator,
      data: encodeSetRulesetOfCollection(
        p.tokenAddress,
        VANILLA_RULESET_ID,
        ZERO_ADDRESS,
        0n,
        0n,
      ),
      value: valueHex(0n),
    },
  ];
}

/** ABI-encode Ownable `transferOwnership(newOwner)` (`cast`: `0xf2fde38b`). */
export function encodeTransferOwnership(newOwner: string): string {
  return encodeFunctionData(
    "transferOwnership(address)",
    ["address"],
    [newOwner],
  );
}

/**
 * `token.transferOwnership(dao)` — hands a treasury-owned apptoken to the DAO
 * (the holder of the fee/spread levers) once the launch has graduated.
 * Owner-only: the current owner (the treasury wallet) must sign it.
 */
export function buildTransferTokenOwnershipCall(
  token: string,
  newOwner: string,
): EvmCall {
  return {
    to: token,
    data: encodeTransferOwnership(newOwner),
    value: valueHex(0n),
  };
}

// ---------------------------------------------------------------------------
// Graduation — contracts/src/GraduationExecutor.sol
// ---------------------------------------------------------------------------

/** ABI-encode `GraduationExecutor.executeGraduation(address)`. */
export function encodeExecuteGraduation(auction: string): string {
  return encodeFunctionData(
    SIGNATURE_EXECUTE_GRADUATION,
    ["address"],
    [auction],
  );
}

/**
 * The single `executor.executeGraduation(auction)` call: sweeps the graduated
 * auction's proceeds and unsold tokens, splits the raise into reserve escrow
 * (`reserveBps`) + treasury, and records the graduation — all atomically in
 * one call. Callable by anyone; the executor must be the auction's
 * `fundsRecipient` AND `tokensRecipient` or the call reverts with a typed
 * misconfiguration error.
 */
export function buildGraduationCall(
  executor: string,
  auction: string,
): EvmCall {
  return {
    to: executor,
    data: encodeExecuteGraduation(auction),
    value: valueHex(0n),
  };
}

// ---------------------------------------------------------------------------
// Funding + binding the auction — the steps between "auction created" and
// "bids can land". Without them the CCA reverts `TokensNotReceived` on every
// bid and checkpoint, and the executor/hook refuse every caller.
// ---------------------------------------------------------------------------

/** ABI-encode ERC-20 `transfer(to, amount)`. */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  return encodeFunctionData(
    SIGNATURE_ERC20_TRANSFER,
    ["address", "uint256"],
    [to, amount],
  );
}

/** ABI-encode ERC-20 `balanceOf(holder)` (an `eth_call`, not a send). */
export function encodeErc20BalanceOf(holder: string): string {
  return encodeFunctionData(SIGNATURE_ERC20_BALANCE_OF, ["address"], [holder]);
}

/** ABI-encode `auction.onTokensReceived()` (no arguments). */
export function encodeOnTokensReceived(): string {
  return SELECTOR_ON_TOKENS_RECEIVED;
}

/** ABI-encode `GraduationExecutor.bindAuction(auction)`. */
export function encodeBindAuction(auction: string): string {
  return encodeFunctionData(SIGNATURE_BIND_AUCTION, ["address"], [auction]);
}

/** ABI-encode `AllowlistHook.setAuction(auction)`. */
export function encodeSetHookAuction(auction: string): string {
  return encodeFunctionData(SIGNATURE_SET_HOOK_AUCTION, ["address"], [auction]);
}

/** ABI-encode `GraduationExecutor.withdrawStuckReserve(auction)`. */
export function encodeWithdrawStuckReserve(auction: string): string {
  return encodeFunctionData(
    SIGNATURE_WITHDRAW_STUCK_RESERVE,
    ["address"],
    [auction],
  );
}

/**
 * `token.transfer(auction, amount)` — moves the WHOLE sale supply from the
 * treasury wallet into the auction. The CCA only starts once it holds at least
 * its `totalSupply` (`onTokensReceived` reverts `InvalidTokenAmountReceived`
 * otherwise), and nothing else in the app moved these tokens before.
 */
export function buildFundAuctionCall(
  token: string,
  auction: string,
  amount: bigint,
): EvmCall {
  return {
    to: token,
    data: encodeErc20Transfer(auction, amount),
    value: valueHex(0n),
  };
}

/**
 * `auction.onTokensReceived()` — tells the CCA its supply arrived. Idempotent
 * upstream (a second call returns early), so a retry is always safe. Until it
 * runs every `submitBid` and `checkpoint` reverts `TokensNotReceived`.
 */
export function buildOnTokensReceivedCall(auction: string): EvmCall {
  return { to: auction, data: encodeOnTokensReceived(), value: valueHex(0n) };
}

/**
 * `executor.bindAuction(auction)` — the one-shot, treasury-only binding that
 * makes the executor serve exactly this auction. Call right after the auction
 * exists; the executor refuses every other address.
 */
export function buildBindAuctionCall(
  executor: string,
  auction: string,
): EvmCall {
  return {
    to: executor,
    data: encodeBindAuction(auction),
    value: valueHex(0n),
  };
}

/**
 * `hook.setAuction(auction)` — curated track only. The AllowlistHook's
 * `validate` accrues per-wallet caps, so it answers only to the auction it is
 * bound to (one-shot, owner-only). Bids revert until this lands.
 */
export function buildSetHookAuctionCall(
  hook: string,
  auction: string,
): EvmCall {
  return {
    to: hook,
    data: encodeSetHookAuction(auction),
    value: valueHex(0n),
  };
}

/**
 * `executor.withdrawStuckReserve(auction)` — the treasury takes an unreleased
 * reserve back. Reverts `ReserveLocked` until graduation + `reserveLockSeconds`
 * and `AlreadyReleased` once a pool was recorded; pays the treasury only.
 */
export function buildWithdrawStuckReserveCall(
  executor: string,
  auction: string,
): EvmCall {
  return {
    to: executor,
    data: encodeWithdrawStuckReserve(auction),
    value: valueHex(0n),
  };
}
