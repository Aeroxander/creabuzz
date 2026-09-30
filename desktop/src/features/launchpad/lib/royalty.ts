/**
 * Royalty statement read model: the minimal onchain ABI surface plus the pure
 * helpers behind {@link RoyaltyStatementCard}.
 *
 * Sources of truth for every signature and every formula:
 * - `contracts/src/RoyaltyDistributor.sol` — the onchain royalty ledger:
 *   `claimableOf` (credited, never expires — D2), `allocOf` / `openBal`
 *   (entitlement inputs), `schedules(bytes32)` (the minted schedule),
 *   `bandOf`, `nextClose`, `carry`, `pendingRevenue`, and the unmoderated
 *   `claim()` pull.
 * - `contracts/src/ClaimStake.sol` — `royaltyReq(bytes32)`, the attested
 *   request a schedule was minted verbatim from (provenance → kind 37013).
 * - `docs/token-lifecycle-design.md` §3.3 (accrual `h`, trapezoidal v1:
 *   `h = min(1, (open+close)/2 / alloc)`), §3.4 (credited balances), and
 *   §7 "UI (web + desktop)" (statement card surface).
 *
 * Encoding rides the launchpad's generic ABI encoder (`lib/evmCalls.ts`) and
 * the `chainRpc` return decoders — no new web3 stack, the same conventions as
 * `lib/chainRpc.ts` (selectors derived with keccak-256 and cross-checked with
 * `cast sig`, values pinned in the tests). Reads go through the `evm_call`
 * Tauri IPC command; `claim()` is composed here and sent through
 * `evm_send_transaction` (see the statement card's hooks).
 */

import { decodeUint256 } from "@/features/launchpad/lib/chainRpc";
import {
  encodeFunctionData,
  selectorOf,
  type EvmCall,
} from "@/features/launchpad/lib/evmCalls";

// ---------------------------------------------------------------------------
// Canonical signatures and selectors (cross-checked with `cast sig`)
// ---------------------------------------------------------------------------

/** `claimableOf(address)` — credited balance, claimable forever (D2). */
export const SIGNATURE_CLAIMABLE_OF = "claimableOf(address)";
/** `allocOf(address)` — Σ earned token allocations. */
export const SIGNATURE_ALLOC_OF = "allocOf(address)";
/** `openBal(address)` — project-token balance at the last window close. */
export const SIGNATURE_OPEN_BAL = "openBal(address)";
/**
 * `schedules(bytes32)` — the minted schedule:
 * `(address contributor, uint64 start, uint64 end, uint32 weight, uint8 band,
 * uint128 allocation, bool suspended)`.
 */
export const SIGNATURE_SCHEDULES = "schedules(bytes32)";
/** `bandOf(address)` — highest badge tier across schedules (0 = none). */
export const SIGNATURE_BAND_OF = "bandOf(address)";
/** `nextClose()` — unix seconds of the next settlement close. */
export const SIGNATURE_NEXT_CLOSE = "nextClose()";
/** `carry()` — unattributable revenue carried into the next pool (D4). */
export const SIGNATURE_CARRY = "carry()";
/** `pendingRevenue()` — funded, not yet settled. */
export const SIGNATURE_PENDING_REVENUE = "pendingRevenue()";
/** `claim()` — the unmoderated pull of a credited balance. */
export const SIGNATURE_CLAIM = "claim()";
/**
 * ClaimStake `royaltyReq(bytes32)` — the attested request
 * `(uint32 weight, uint64 term, uint8 band, uint128 allocation)`.
 */
export const SIGNATURE_ROYALTY_REQ = "royaltyReq(bytes32)";
/** `currency()` — the distributor's revenue currency (ERC-20). */
export const SIGNATURE_CURRENCY = "currency()";
/** `projectToken()` — the launched project token (ERC-20). */
export const SIGNATURE_PROJECT_TOKEN = "projectToken()";
/** `decimals()` — standard ERC-20 display decimals. */
export const SIGNATURE_DECIMALS = "decimals()";
/** `balanceOf(address)` — standard ERC-20 balance (the close sample input). */
export const SIGNATURE_BALANCE_OF = "balanceOf(address)";

/** Selector of {@link SIGNATURE_CLAIMABLE_OF} (`cast`: `0x8903ab9d`). */
export const SELECTOR_CLAIMABLE_OF = selectorOf(SIGNATURE_CLAIMABLE_OF);
/** Selector of {@link SIGNATURE_ALLOC_OF} (`cast`: `0x80627e3f`). */
export const SELECTOR_ALLOC_OF = selectorOf(SIGNATURE_ALLOC_OF);
/** Selector of {@link SIGNATURE_OPEN_BAL} (`cast`: `0x63baa3df`). */
export const SELECTOR_OPEN_BAL = selectorOf(SIGNATURE_OPEN_BAL);
/** Selector of {@link SIGNATURE_SCHEDULES} (`cast`: `0xd1e16bfa`). */
export const SELECTOR_SCHEDULES = selectorOf(SIGNATURE_SCHEDULES);
/** Selector of {@link SIGNATURE_BAND_OF} (`cast`: `0x8c6f511c`). */
export const SELECTOR_BAND_OF = selectorOf(SIGNATURE_BAND_OF);
/** Selector of {@link SIGNATURE_NEXT_CLOSE} (`cast`: `0x09038a56`). */
export const SELECTOR_NEXT_CLOSE = selectorOf(SIGNATURE_NEXT_CLOSE);
/** Selector of {@link SIGNATURE_CARRY} (`cast`: `0xf02ec765`). */
export const SELECTOR_CARRY = selectorOf(SIGNATURE_CARRY);
/** Selector of {@link SIGNATURE_PENDING_REVENUE} (`cast`: `0xf9a758e5`). */
export const SELECTOR_PENDING_REVENUE = selectorOf(SIGNATURE_PENDING_REVENUE);
/** Selector of {@link SIGNATURE_CLAIM} (`cast`: `0x4e71d92d`). */
export const SELECTOR_CLAIM = selectorOf(SIGNATURE_CLAIM);
/** Selector of {@link SIGNATURE_ROYALTY_REQ} (`cast`: `0x5c458d5d`). */
export const SELECTOR_ROYALTY_REQ = selectorOf(SIGNATURE_ROYALTY_REQ);
/** Selector of {@link SIGNATURE_CURRENCY} (`cast`: `0xe5a6b10f`). */
export const SELECTOR_CURRENCY = selectorOf(SIGNATURE_CURRENCY);
/** Selector of {@link SIGNATURE_PROJECT_TOKEN} (`cast`: `0x4b60ce77`). */
export const SELECTOR_PROJECT_TOKEN = selectorOf(SIGNATURE_PROJECT_TOKEN);
/** Selector of {@link SIGNATURE_DECIMALS} (`cast`: `0x313ce567`). */
export const SELECTOR_DECIMALS = selectorOf(SIGNATURE_DECIMALS);
/** Selector of {@link SIGNATURE_BALANCE_OF} (`cast`: `0x70a08231`). */
export const SELECTOR_BALANCE_OF = selectorOf(SIGNATURE_BALANCE_OF);

// ---------------------------------------------------------------------------
// Read calldata builders
// ---------------------------------------------------------------------------

/** ABI-encode `claimableOf(address)`. */
export function encodeClaimableOf(contributor: string): string {
  return encodeFunctionData(SIGNATURE_CLAIMABLE_OF, ["address"], [contributor]);
}

/** ABI-encode `allocOf(address)`. */
export function encodeAllocOf(contributor: string): string {
  return encodeFunctionData(SIGNATURE_ALLOC_OF, ["address"], [contributor]);
}

/** ABI-encode `openBal(address)`. */
export function encodeOpenBal(contributor: string): string {
  return encodeFunctionData(SIGNATURE_OPEN_BAL, ["address"], [contributor]);
}

/** ABI-encode `schedules(bytes32)` — `claimId` is 32 bytes of hex. */
export function encodeSchedules(claimId: string): string {
  return encodeFunctionData(SIGNATURE_SCHEDULES, ["bytes32"], [claimId]);
}

/** ABI-encode `bandOf(address)`. */
export function encodeBandOf(contributor: string): string {
  return encodeFunctionData(SIGNATURE_BAND_OF, ["address"], [contributor]);
}

/** ABI-encode `nextClose()`. */
export function encodeNextClose(): string {
  return encodeFunctionData(SIGNATURE_NEXT_CLOSE, [], []);
}

/** ABI-encode `carry()`. */
export function encodeCarry(): string {
  return encodeFunctionData(SIGNATURE_CARRY, [], []);
}

/** ABI-encode `pendingRevenue()`. */
export function encodePendingRevenue(): string {
  return encodeFunctionData(SIGNATURE_PENDING_REVENUE, [], []);
}

/** ABI-encode ClaimStake `royaltyReq(bytes32)`. */
export function encodeRoyaltyReq(claimId: string): string {
  return encodeFunctionData(SIGNATURE_ROYALTY_REQ, ["bytes32"], [claimId]);
}

/** ABI-encode `currency()`. */
export function encodeCurrency(): string {
  return encodeFunctionData(SIGNATURE_CURRENCY, [], []);
}

/** ABI-encode `projectToken()`. */
export function encodeProjectToken(): string {
  return encodeFunctionData(SIGNATURE_PROJECT_TOKEN, [], []);
}

/** ABI-encode `decimals()`. */
export function encodeDecimals(): string {
  return encodeFunctionData(SIGNATURE_DECIMALS, [], []);
}

/** ABI-encode `balanceOf(address)`. */
export function encodeBalanceOf(holder: string): string {
  return encodeFunctionData(SIGNATURE_BALANCE_OF, ["address"], [holder]);
}

// ---------------------------------------------------------------------------
// Write call
// ---------------------------------------------------------------------------

/**
 * The `claim()` pull on the distributor — the one unmoderated withdrawal in
 * the system (D2). Nonpayable: no args, no value.
 */
export function buildRoyaltyClaimCall(distributor: string): EvmCall {
  return {
    to: distributor,
    data: encodeFunctionData(SIGNATURE_CLAIM, [], []),
    value: "0x0",
  };
}

// ---------------------------------------------------------------------------
// Return decoders (32-byte words, as `evm_call` returns them)
// ---------------------------------------------------------------------------

/** A minted royalty schedule, exactly as `schedules(bytes32)` returns it. */
export interface RoyaltySchedule {
  /** The bound contributor address. */
  contributor: string;
  /** Term start (unix seconds). */
  start: bigint;
  /** Term end (unix seconds) — the countdown target. */
  end: bigint;
  /** Share points over the contributor pool. */
  weight: number;
  /** Badge tier 1/2/3. */
  band: number;
  /** Earned token allocation registered at mint. */
  allocation: bigint;
  /** Freeze carve-out (§3.1): stops future accrual, never touches credits. */
  suspended: boolean;
}

/** The attested ClaimStake request a schedule was minted verbatim from. */
export interface AttestedRoyaltyReq {
  weight: number;
  /** Term length in seconds. */
  term: bigint;
  band: number;
  allocation: bigint;
}

function wordAt(data: string, index: number): string {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const start = index * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64)
    throw new Error(`bad return data: word ${index} is not 32 bytes`);
  return word;
}

/** Decode a 32-byte ABI address word to a lowercase 0x address. */
export function decodeAddressWord(word: string): string {
  const body = word.startsWith("0x") ? word.slice(2) : word;
  if (body.length !== 64) throw new Error("expected 32-byte address word");
  return `0x${body.slice(24).toLowerCase()}`;
}

/** Decode a 32-byte word to a JS number (uint32/uint8 return values). */
function decodeSmallUint(word: string): number {
  return Number(decodeUint256(word));
}

/** Decode the 7-word `schedules(bytes32)` return. */
export function decodeScheduleResult(returnData: string): RoyaltySchedule {
  return {
    contributor: decodeAddressWord(wordAt(returnData, 0)),
    start: decodeUint256(wordAt(returnData, 1)),
    end: decodeUint256(wordAt(returnData, 2)),
    weight: decodeSmallUint(wordAt(returnData, 3)),
    band: decodeSmallUint(wordAt(returnData, 4)),
    allocation: decodeUint256(wordAt(returnData, 5)),
    suspended: decodeUint256(wordAt(returnData, 6)) !== 0n,
  };
}

/** Decode the 4-word ClaimStake `royaltyReq(bytes32)` return. */
export function decodeRoyaltyReqResult(returnData: string): AttestedRoyaltyReq {
  return {
    weight: decodeSmallUint(wordAt(returnData, 0)),
    term: decodeUint256(wordAt(returnData, 1)),
    band: decodeSmallUint(wordAt(returnData, 2)),
    allocation: decodeUint256(wordAt(returnData, 3)),
  };
}

// ---------------------------------------------------------------------------
// Pure read-model helpers (unit-tested in royalty.test.mjs)
// ---------------------------------------------------------------------------

/**
 * `h` fixed-point scale — mirrors the distributor's `1e18` integer math so
 * the displayed `h` matches what settlement will actually apply.
 */
export const H_SCALE = 10n ** 18n;

/**
 * Trapezoidal held sample for the running window (design §3.3 v1):
 * the balance at the last close and the balance now, averaged.
 */
export function averageHeld(openBal: bigint, heldNow: bigint): bigint {
  return (openBal + heldNow) / 2n;
}

/**
 * Accrual factor `h = min(1, (open + now)/2 / alloc)`, H_SCALE-scaled.
 * Mirrors `RoyaltyDistributor.settle()` exactly, including its
 * `avg >= alloc ? 1e18 : …` clamp (so an empty allocation, `alloc = 0`,
 * reads as full — schedules always carry `allocation > 0` in practice).
 */
export function accrualH(
  openBal: bigint,
  heldNow: bigint,
  allocation: bigint,
): bigint {
  const avg = averageHeld(openBal, heldNow);
  return avg >= allocation ? H_SCALE : (avg * H_SCALE) / allocation;
}

/**
 * Display form for an H_SCALE-scaled `h`: exact percent with at most one
 * decimal ("62.5%", "100%", "0%"), clamped to 100% at the top.
 */
export function formatH(h: bigint): string {
  const clamped = h > H_SCALE ? H_SCALE : h;
  const tenths = (clamped * 1000n) / H_SCALE;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? `${whole}%` : `${whole}.${frac}%`;
}

/**
 * Badge tier label for a schedule band (1/2/3 → Tier I/II/III). Anything
 * outside the band table renders as an em dash, never a guessed tier.
 */
export function bandLabel(band: number): string {
  switch (band) {
    case 1:
      return "Tier I";
    case 2:
      return "Tier II";
    case 3:
      return "Tier III";
    default:
      return "—";
  }
}

/**
 * Exact decimal rendering of a smallest-unit amount (no floats, no grouping —
 * machine values stay machine-readable): `1500000n, 6` → `"1.5"`.
 */
export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new Error("decimals must be a non-negative integer");
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (decimals === 0 || frac === 0n) return `${sign}${whole}`;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fracText}`;
}

/** A term-end countdown against the schedule's `end` (unix seconds). */
export interface TermCountdown {
  /** True once `end` is at or before `now` — the stream has stopped. */
  ended: boolean;
  /** Seconds before `end`; 0 once ended. */
  secondsRemaining: number;
  /** Days before `end`, rounded up; 0 once ended. */
  daysRemaining: number;
  /** Plain-language countdown: "214 days left" / "1 day left" / "Term ended". */
  label: string;
}

/**
 * Countdown to a schedule's term end. Per the bounded-term rule (§3.1) an
 * ended term stops the stream — it never touches what was already credited.
 */
export function termCountdown(
  endSeconds: bigint | number,
  nowSeconds: number,
): TermCountdown {
  const end = typeof endSeconds === "bigint" ? Number(endSeconds) : endSeconds;
  const remaining = Math.floor(end) - Math.floor(nowSeconds);
  if (remaining <= 0) {
    return {
      ended: true,
      secondsRemaining: 0,
      daysRemaining: 0,
      label: "Term ended",
    };
  }
  const days = Math.ceil(remaining / 86400);
  return {
    ended: false,
    secondsRemaining: remaining,
    daysRemaining: days,
    label: days === 1 ? "1 day left" : `${days} days left`,
  };
}
