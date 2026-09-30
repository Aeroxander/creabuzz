/**
 * Royalty statement read model: the minimal onchain ABI surface plus the pure
 * helpers behind {@link ../ui/RoyaltyStatementCard}.
 *
 * Sources of truth for every signature and every formula (all references
 * READ-ONLY):
 * - `contracts/src/RoyaltyDistributor.sol` — the onchain royalty ledger:
 *   `claimableOf` (credited, never expires — D2), `allocOf` / `openBal`
 *   (entitlement inputs), `schedules(bytes32)` (the minted schedule),
 *   `bandOf`, `nextClose`, `carry`, `pendingRevenue`, and the unmoderated
 *   `claim()` pull.
 * - `contracts/src/ClaimStake.sol` — `royaltyReq(bytes32)`, the attested
 *   request a schedule was minted verbatim from (provenance → kind 37013).
 * - `docs/token-lifecycle-design.md` §3.3 (accrual `h`, trapezoidal v1:
 *   `h = min(1, (open + now)/2 / alloc)` in 1e18 integer math), §3.4
 *   (credited balances), and §7 "UI (web + desktop)" (statement card).
 *
 * Web conventions (`fund-flow.ts`, `ragequit-tx.ts`): selectors are literal
 * `cast sig` goldens (each pinned in `royalty.test.mjs`), encoding is
 * whole-word hex — no web3 stack. Everything here is pure; the card drives
 * the builders through the `../chain.ts` `ethCall` seam and sends `claim()`
 * through the sender picker (`ui/SenderPicker.tsx`).
 */

// ---------------------------------------------------------------------------
// Canonical signatures and selectors (cast sig goldens, pinned in tests)
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

/** `cast sig 'claimableOf(address)'` (golden). */
export const SELECTOR_CLAIMABLE_OF = "0x8903ab9d";
/** `cast sig 'allocOf(address)'` (golden). */
export const SELECTOR_ALLOC_OF = "0x80627e3f";
/** `cast sig 'openBal(address)'` (golden). */
export const SELECTOR_OPEN_BAL = "0x63baa3df";
/** `cast sig 'schedules(bytes32)'` (golden). */
export const SELECTOR_SCHEDULES = "0xd1e16bfa";
/** `cast sig 'bandOf(address)'` (golden). */
export const SELECTOR_BAND_OF = "0x8c6f511c";
/** `cast sig 'nextClose()'` (golden). */
export const SELECTOR_NEXT_CLOSE = "0x09038a56";
/** `cast sig 'carry()'` (golden). */
export const SELECTOR_CARRY = "0xf02ec765";
/** `cast sig 'pendingRevenue()'` (golden). */
export const SELECTOR_PENDING_REVENUE = "0xf9a758e5";
/** `cast sig 'claim()'` (golden). */
export const SELECTOR_CLAIM = "0x4e71d92d";
/** ClaimStake `cast sig 'royaltyReq(bytes32)'` (golden). */
export const SELECTOR_ROYALTY_REQ = "0x5c458d5d";
/** `cast sig 'currency()'` (golden — same as `fund-flow.ts`'s). */
export const SELECTOR_CURRENCY = "0xe5a6b10f";
/** `cast sig 'projectToken()'` (golden). */
export const SELECTOR_PROJECT_TOKEN = "0x4b60ce77";
/** `cast sig 'decimals()'` (golden). */
export const SELECTOR_DECIMALS = "0x313ce567";
/** `cast sig 'balanceOf(address)'` (golden). */
export const SELECTOR_BALANCE_OF = "0x70a08231";

// ---------------------------------------------------------------------------
// Read calldata builders (whole-word hex, `fund-flow.ts` style)
// ---------------------------------------------------------------------------

function requireAddress(value: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`royalty: ${what} must be a 0x address, got ${value}`);
  }
  return value.toLowerCase();
}

function requireBytes32(value: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`royalty: ${what} must be 32 bytes of hex, got ${value}`);
  }
  return value.toLowerCase();
}

function addressWord(address: string): string {
  return requireAddress(address, "address").slice(2).padStart(64, "0");
}

/** ABI-encode `claimableOf(address)`. */
export function encodeClaimableOf(contributor: string): string {
  return `${SELECTOR_CLAIMABLE_OF}${addressWord(contributor)}`;
}

/** ABI-encode `allocOf(address)`. */
export function encodeAllocOf(contributor: string): string {
  return `${SELECTOR_ALLOC_OF}${addressWord(contributor)}`;
}

/** ABI-encode `openBal(address)`. */
export function encodeOpenBal(contributor: string): string {
  return `${SELECTOR_OPEN_BAL}${addressWord(contributor)}`;
}

/** ABI-encode `schedules(bytes32)` — `claimId` is 32 bytes of hex. */
export function encodeSchedules(claimId: string): string {
  return `${SELECTOR_SCHEDULES}${requireBytes32(claimId, "claim id").slice(2)}`;
}

/** ABI-encode `bandOf(address)`. */
export function encodeBandOf(contributor: string): string {
  return `${SELECTOR_BAND_OF}${addressWord(contributor)}`;
}

/** ABI-encode `nextClose()`. */
export function encodeNextClose(): string {
  return SELECTOR_NEXT_CLOSE;
}

/** ABI-encode `carry()`. */
export function encodeCarry(): string {
  return SELECTOR_CARRY;
}

/** ABI-encode `pendingRevenue()`. */
export function encodePendingRevenue(): string {
  return SELECTOR_PENDING_REVENUE;
}

/** ABI-encode ClaimStake `royaltyReq(bytes32)`. */
export function encodeRoyaltyReq(claimId: string): string {
  return `${SELECTOR_ROYALTY_REQ}${requireBytes32(claimId, "claim id").slice(2)}`;
}

/** ABI-encode `currency()`. */
export function encodeCurrency(): string {
  return SELECTOR_CURRENCY;
}

/** ABI-encode `projectToken()`. */
export function encodeProjectToken(): string {
  return SELECTOR_PROJECT_TOKEN;
}

/** ABI-encode `decimals()`. */
export function encodeDecimals(): string {
  return SELECTOR_DECIMALS;
}

/** ABI-encode `balanceOf(address)`. */
export function encodeBalanceOf(holder: string): string {
  return `${SELECTOR_BALANCE_OF}${addressWord(holder)}`;
}

// ---------------------------------------------------------------------------
// Write call
// ---------------------------------------------------------------------------

/** One sendable call in the `SenderCall` shape (`identity/lib/sponsoredSender`). */
export interface RoyaltyClaimCall {
  to: string;
  data: string;
  /** Quantity string; `claim()` is nonpayable, so always zero. */
  value: string;
}

/**
 * The `claim()` pull on the distributor — the one unmoderated withdrawal in
 * the system (D2). Nonpayable: no args, no value. The composed bytes are
 * sender-agnostic (the `SenderPicker` rule).
 */
export function buildRoyaltyClaimCall(distributor: string): RoyaltyClaimCall {
  return {
    to: requireAddress(distributor, "distributor"),
    data: SELECTOR_CLAIM,
    value: "0x0",
  };
}

// ---------------------------------------------------------------------------
// Return decoders (32-byte words, as `eth_call` returns them)
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

function wordList(hex: string): string[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 64 !== 0) {
    throw new Error(`royalty: expected whole ABI words, got ${hex}`);
  }
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

function wordValue(word: string): bigint {
  return BigInt(`0x${word}`);
}

/** Decode a 32-byte word to a JS number (uint32/uint8 return values). */
function smallUint(word: string): number {
  return Number(wordValue(word));
}

/**
 * Decode the first 32-byte word of return data as an address — what the
 * `currency()` / `projectToken()` getters answer. Throws on a short or
 * garbled word rather than rendering a bogus address.
 */
export function decodeAddressWord(returnData: string): string {
  const [first] = wordList(returnData);
  if (first === undefined || wordValue(first) >> 160n !== 0n) {
    throw new Error("royalty: return data is not an address word");
  }
  return `0x${first.slice(24).toLowerCase()}`;
}

/** Decode the 7-word `schedules(bytes32)` return. */
export function decodeScheduleResult(returnData: string): RoyaltySchedule {
  const words = wordList(returnData);
  if (words.length !== 7) {
    throw new Error(
      `royalty: expected 7 words from schedules(bytes32), got ${words.length}`,
    );
  }
  return {
    contributor: `0x${words[0].slice(24).toLowerCase()}`,
    start: wordValue(words[1]),
    end: wordValue(words[2]),
    weight: smallUint(words[3]),
    band: smallUint(words[4]),
    allocation: wordValue(words[5]),
    suspended: wordValue(words[6]) !== 0n,
  };
}

/** Decode the 4-word ClaimStake `royaltyReq(bytes32)` return. */
export function decodeRoyaltyReqResult(returnData: string): AttestedRoyaltyReq {
  const words = wordList(returnData);
  if (words.length !== 4) {
    throw new Error(
      `royalty: expected 4 words from royaltyReq(bytes32), got ${words.length}`,
    );
  }
  return {
    weight: smallUint(words[0]),
    term: wordValue(words[1]),
    band: smallUint(words[2]),
    allocation: wordValue(words[3]),
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
 * Trapezoidal held sample for the running window (design §3.3 v1): the
 * balance at the last close and the balance now, averaged. Integer division
 * floors exactly like the contract's `(open + close) / 2`.
 */
export function averageHeld(openBal: bigint, heldNow: bigint): bigint {
  return (openBal + heldNow) / 2n;
}

/**
 * Accrual factor `h = min(1, (open + now)/2 / alloc)`, H_SCALE-scaled.
 * Mirrors `RoyaltyDistributor.settle()` exactly, including its
 * `avg >= alloc ? 1e18 : …` clamp — so an over-held sample reads as full and
 * an empty allocation (`alloc = 0`) also reads as full (schedules always
 * carry `allocation > 0` in practice; the contract's comparison can never
 * divide by zero).
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
 * decimal ("62.5%", "100%", "0%"), clamped to 100% at the top. Integer math
 * only — no floats anywhere in the path.
 */
export function formatH(h: bigint): string {
  const clamped = h > H_SCALE ? H_SCALE : h;
  const tenths = (clamped * 1000n) / H_SCALE;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? `${whole}%` : `${whole}.${frac}%`;
}

/**
 * Badge tier label for a schedule band (1/2/3 → Tier I/II/III, the §8 band
 * table). Anything outside the band table renders as an em dash, never a
 * guessed tier.
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
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }
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
