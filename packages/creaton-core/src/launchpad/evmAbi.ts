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
export function valueHex(n: bigint): string {
  return `0x${n.toString(16)}`;
}
