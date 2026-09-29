/**
 * Pure calldata builders for the auction deploy and graduation flows on the
 * web (`auctionFlow.ts`, `graduationFlow.ts`, `graduationArtifact.ts`).
 *
 * This is the auction/graduation SUBSET of the desktop app's
 * `desktop/src/features/launchpad/lib/evmCalls.ts`. The desktop file also
 * carries bid/exit/claim and token-deploy builders; on the web those already
 * live in `bid-tx.ts`, `claim-tx.ts` and `mint-tx.ts` and are deliberately not
 * duplicated here. What is kept is byte-for-byte the desktop code, so a fix on
 * one side is a copy to the other.
 *
 * Every builder returns **ordered unsigned calls**; signing and broadcasting
 * stay with the sender. Nothing here touches the network, the clock, or the
 * DOM — inputs in, bytes out — so the surface is deterministically testable
 * against `cast` golden vectors (`evmCalls.test.mjs`).
 *
 * Encoding is hand-rolled (fixed-width head words + dynamic tails) through the
 * small generic ABI encoder below: no wallet library. Function selectors are
 * derived with keccak-256 from the canonical signature strings via
 * `@noble/hashes` rather than pinned as hex literals; the tests cross-check
 * every derived selector against `cast sig`.
 *
 * Sources of truth for every layout:
 * - Graduation: `contracts/src/GraduationExecutor.sol`
 *   (`executeGraduation(address)`).
 * - Funding and binding the auction: `contracts/src/GraduationExecutor.sol`
 *   (`bindAuction`), `contracts/src/AllowlistHook.sol` (`setAuction`), and the
 *   vendored CCA `onTokensReceived()`.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

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
