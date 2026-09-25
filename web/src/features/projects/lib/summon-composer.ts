/**
 * Summon composer: the Project Board's kind:37011 equity map → majeur's
 * `summon(...)` call bytes.
 *
 * Why this exists: a kind:37011 grant is a Nostr record — revocable, offchain,
 * worth nothing to a Moloch. `contracts/lib/majeur/src/Moloch.sol:2066`
 * `summon(...)` is the act that makes it real: it CREATE2-clones a DAO
 * (`:2078-2086`), then `:238` `Shares(_shares).init(initHolders, initShares)`
 * mints the initial shares, after which the holder has Moloch voting power,
 * `ragequit` (`Moloch.sol:759`) for a proportional-treasury exit, and
 * `buyShares` for later joins. This module composes that one call — and
 * refuses, loudly, when the map cannot be minted as it stands.
 *
 * What it holds the line on (all of it before any bytes exist):
 *
 * - **Addresses come from bindings, never from guesswork.** A grantee with no
 *   bound EVM address is a blocker that names the seat, not a missing row:
 *   `initHolders` is an `address[]`, and inventing one would mint real shares
 *   to a stranger.
 * - **The caps are checked before composition** — the 100% pool
 *   (`manifest.ts` `POOL_PCT`) and the budget envelope of
 *   `launch-params.ts:140-155`: `budget * 6 <= requiredCurrencyRaised` (the
 *   1/6 rule) with the 3× large-spend default-pass ceiling reported next to
 *   it. An over-cap map blocks composition with the exact numbers named.
 * - **One call, or nothing.** `callData` is `null` whenever any blocker
 *   exists; there is no partial summon (Review-Proven Rule 5: one user action
 *   = one durable write, and a half-composed map is not an action).
 *
 * Share scale — `SHARES_PER_PERCENT = 10^18` (a deliberate choice, cited):
 * `Moloch.sol:1064` fixes `decimals = 18` on the Shares token, and the dev
 * harness `contracts/script/DeployOrgDao.s.sol:44-45` mints `1e18` wei of
 * shares per holder. Setting one whole percent of the pool to exactly `1e18`
 * keeps that convention (a 1% seat *is* the harness's unit), makes the 100%
 * pool `1e20` shares — far inside uint256, and `_mint` has no supply cap
 * (`Moloch.sol:1175-1183`) — and leaves room for sub-percent seats later
 * (`mintFromMoloch`, `Moloch.sol:1157`).
 *
 * Encoder: `identity/lib/userop-abi.ts` `abiEncodeCall` (import READ-ONLY),
 * the same one `launchpad/lib/ragequit-tx.ts` binds with `cast` goldens;
 * `address[]`/`uint256[]`/`Call[]` are encoded as `tuple[]` of single/static
 * tuples, which is byte-identical to `abi.encode` of the arrays (the goldens
 * in `summon-composer.test.mjs` prove it).
 *
 * Inputs are already canonical: `map` is `ProjectState.team` from `state.ts`
 * (newest record per `d`, founder-keyed, revoked grants dropped — that
 * derivation is reused, never re-derived here).
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

import { truncatePubkey } from "../../../shared/lib/pubkey.ts";
import { abiEncodeCall, type AbiField } from "../../identity/lib/userop-abi.ts";
import { formatAtomic, USDC_DECIMALS } from "../../launchpad/lib/amounts.ts";
import { POOL_PCT } from "./manifest.ts";
import type { TeamMember } from "./state.ts";

/**
 * Shares per whole pool percent. Cited above: Shares `decimals = 18`
 * (`Moloch.sol:1064`) and the harness's `1e18` shares per holder
 * (`DeployOrgDao.s.sol:44-45`).
 */
export const SHARES_PER_PERCENT = 10n ** 18n;

/** `Moloch.sol:1951-1955` `struct Call { address target; uint256 value; bytes data; }` */
export type SummonInitCall = { target: string; value: bigint; data: string };

/**
 * `cast sig 'summon(string,string,string,uint16,bool,address,bytes32,address[],uint256[],(address,uint256,bytes)[])'`
 * — the exact signature of `Moloch.sol:2066-2076` (`Call[]` spelled out).
 */
export const SUMMON_SIGNATURE =
  "summon(string,string,string,uint16,bool,address,bytes32,address[],uint256[],(address,uint256,bytes)[])";

/** Golden selector for {@link SUMMON_SIGNATURE} (`cast sig`, pinned). */
export const SUMMON_SELECTOR = "0xfec53795";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
/** Basis points are a `uint16`; 10000 bps = 100% turnout is the logical max. */
const MAX_QUORUM_BPS = 10_000;

/** The onchain identity of the DAO being summoned. */
export interface SummonOrg {
  /**
   * The project's kind:37010 node id — seeds the CREATE2 salt exactly like
   * `contracts/script/DeployOrgDao.s.sol:46`
   * (`bytes32 salt = keccak256(bytes(rootId))`).
   */
  nodeId: string;
  orgName: string;
  orgSymbol: string;
  orgURI?: string;
  /** Defaults to 500 bps, the harness default (`DeployOrgDao.s.sol:43`). */
  quorumBps?: number;
  /** Defaults to `true` (`DeployOrgDao.s.sol:44`). */
  ragequittable?: boolean;
  /** Defaults to the zero address = "no renderer" (`Moloch.sol:228`). */
  renderer?: string;
  initCalls?: readonly SummonInitCall[];
}

/** The cap seam: `launch-params.ts:140-155`'s two figures. */
export interface SummonCapParams {
  /** Monthly operating budget in currency base units, or null when unset. */
  budget: bigint | null;
  /** Graduation threshold in currency base units (the minimum raise). */
  requiredCurrencyRaised: bigint;
  /** Display symbol for the cap line (defaults to the launchpad's USDC). */
  currency?: string;
}

/** How one seat of the map resolves against the bindings. */
export type SummonSeatStatus =
  | "mintable"
  | "unbound"
  | "invalid-address"
  | "invalid-pct";

/** One row of the allocation preview — what will be minted, or why not. */
export interface SummonSeat {
  pubkey: string;
  roleSlug: string;
  roleLabel: string;
  pct: number;
  source: TeamMember["source"];
  /** Lowercased `0x…` when bound; null when the seat cannot be minted. */
  address: string | null;
  /** `pct * SHARES_PER_PERCENT` — what the contract would mint. */
  shares: bigint;
  status: SummonSeatStatus;
}

/** The budget envelope as the preview states it. */
export interface SummonCap {
  budget: bigint | null;
  /** `budget * 6` — what a twelve-month runway at the cap costs. */
  sixMonthCost: bigint | null;
  threshold: bigint;
  /** `budget * 3` — the large-spend default-pass ceiling. */
  defaultPassCost: bigint | null;
  /**
   * `within` = the 1/6 rule holds; `over` = it is violated (blocking);
   * `unchecked` = the record carries no figure to check against (never
   * rendered as "within").
   */
  state: "within" | "over" | "unchecked";
  /** Formatted figures for the cap line; null where the figure is absent. */
  budgetText: string | null;
  sixMonthText: string | null;
  thresholdText: string;
  defaultPassText: string | null;
}

export interface SummonComposition {
  /** Every seat of the map, in board order. */
  seats: SummonSeat[];
  /** Mintable seats only — the contract's `initHolders`. */
  initHolders: string[];
  initShares: bigint[];
  /** Σ seat percentages (all seats, mintable or not). */
  totalPct: number;
  /** Σ minted shares = Σ mintable pct × {@link SHARES_PER_PERCENT}. */
  totalShares: bigint;
  cap: SummonCap;
  /** `null` when anything blocks composition — never a half-built call. */
  callData: string | null;
  /** Why composition is refused. Empty ⇒ `callData` is present. */
  blockers: string[];
  /** Non-blocking facts the preview must still say out loud. */
  warnings: string[];
  ok: boolean;
}

/** `keccak256(bytes(nodeId))` — the harness's salt derivation, in hex. */
export function summonSalt(nodeId: string): string {
  const digest = keccak_256(new TextEncoder().encode(nodeId));
  let out = "0x";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Default ticker for the summon: the project name, uppercased and reduced to
 * letters/digits (`"Nebula Cooperative"` → `"NEBCOO"`), capped at 6 — with
 * `"DAO"` as the floor so no name can produce an empty symbol.
 */
export function deriveOrgSymbol(name: string): string {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  return letters.length > 0 ? letters : "DAO";
}

function formatUnits(value: bigint, currency: string | undefined): string {
  // Full precision: a blocker must name the exact figure, and rounding
  // 5,999,999 base units to "6 USDC" would name the wrong one.
  return formatAtomic(value, USDC_DECIMALS, {
    symbol: currency ?? "USDC",
    maxFractionDigits: USDC_DECIMALS,
  });
}

/**
 * The budget envelope check of `launch-params.ts:140-155`, restated for the
 * summon preview: same predicate (`budget * 6 > requiredCurrencyRaised`),
 * same 3× default-pass figure, and an explicit `unchecked` state so a missing
 * budget can never read as "within" (Review-Proven Rule 1).
 */
function checkCap(
  input: SummonCapParams,
  currency: string | undefined,
  blockers: string[],
  warnings: string[],
): SummonCap {
  const threshold = input.requiredCurrencyRaised;
  const budget = input.budget;
  const budgetText = budget !== null ? formatUnits(budget, currency) : null;
  const thresholdText = formatUnits(threshold, currency);
  const present = budget !== null && budget > 0n;

  if (!present) {
    warnings.push(
      "No monthly budget is committed on the launch record, so the 1/6 envelope (budget × 6 ≤ graduation threshold) cannot be checked — the cap line reads “unknown”, not “within”.",
    );
    return {
      budget,
      sixMonthCost: null,
      threshold,
      defaultPassCost: null,
      state: "unchecked",
      budgetText,
      sixMonthText: null,
      thresholdText,
      defaultPassText: null,
    };
  }
  const sixMonthCost = (budget as bigint) * 6n;
  const defaultPassCost = (budget as bigint) * 3n;
  const sixMonthText = formatUnits(sixMonthCost, currency);
  const defaultPassText = formatUnits(defaultPassCost, currency);
  if (threshold <= 0n) {
    warnings.push(
      `The launch record has no graduation threshold, so the 1/6 envelope cannot be checked against the committed budget of ${budgetText} a month.`,
    );
    return {
      budget,
      sixMonthCost,
      threshold,
      defaultPassCost,
      state: "unchecked",
      budgetText,
      sixMonthText,
      thresholdText,
      defaultPassText,
    };
  }
  if (sixMonthCost > threshold) {
    blockers.push(
      `Budget cap over: ${budgetText} a month × 6 = ${sixMonthText} exceeds the graduation threshold ${thresholdText} (the 1/6 rule, launch-params.ts:149).`,
    );
    return {
      budget,
      sixMonthCost,
      threshold,
      defaultPassCost,
      state: "over",
      budgetText,
      sixMonthText,
      thresholdText,
      defaultPassText,
    };
  }
  return {
    budget,
    sixMonthCost,
    threshold,
    defaultPassCost,
    state: "within",
    budgetText,
    sixMonthText,
    thresholdText,
    defaultPassText,
  };
}

function resolveSeat(
  member: TeamMember,
  bindings: ReadonlyMap<string, string>,
  blockers: string[],
): SummonSeat {
  const label = member.role.label;
  const wholePct = Number.isInteger(member.pct) && member.pct >= 0;
  // Shares are only meaningful for a whole, non-negative percent; anything
  // else renders 0 and blocks below rather than throwing in the encoder.
  const shares = wholePct ? BigInt(member.pct) * SHARES_PER_PERCENT : 0n;
  const issues: SummonSeatStatus[] = [];

  if (!wholePct || member.pct < 1) {
    issues.push("invalid-pct");
    blockers.push(
      `Seat “${label}” (${truncatePubkey(member.pubkey)}) holds ${member.pct}% — a mint needs a whole percentage of at least 1 (shares are ${SHARES_PER_PERCENT} per percent).`,
    );
  }

  const bound = bindings.get(member.pubkey) ?? null;
  let address: string | null = null;
  if (bound === null) {
    issues.push("unbound");
    blockers.push(
      `Seat “${label}” (${member.pct}%, ${truncatePubkey(member.pubkey)}) has no bound EVM address — a seat with no bound address cannot be minted. Ask them to sign in with their wallet so the relay records the binding.`,
    );
  } else if (!ADDRESS_RE.test(bound)) {
    issues.push("invalid-address");
    blockers.push(
      `Seat “${label}” (${truncatePubkey(member.pubkey)}) binds to “${bound}”, which is not a 0x address — refused rather than guessed.`,
    );
  } else {
    address = bound.toLowerCase();
  }

  return {
    pubkey: member.pubkey,
    roleSlug: member.role.slug,
    roleLabel: label,
    pct: member.pct,
    source: member.source,
    address,
    shares,
    // First issue wins; every issue already produced its own blocker.
    status: issues[0] ?? "mintable",
  };
}

/**
 * Compose (or refuse) the summon call for one project's equity map.
 *
 * @param map `ProjectState.team` — the canonical map (state.ts), not raw events
 * @param bindings pubkey → bound EVM address (see {@link localBindingMap})
 * @param launchParams the cap figures from the project's launch record
 * @param org the onchain identity of the DAO (name/symbol/salt)
 */
export function composeSummon(
  map: readonly TeamMember[],
  bindings: ReadonlyMap<string, string>,
  launchParams: SummonCapParams,
  org: SummonOrg,
): SummonComposition {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const cap = checkCap(launchParams, launchParams.currency, blockers, warnings);

  if (map.length === 0) {
    blockers.push(
      "The equity map has no seats — there is nothing to mint at summon.",
    );
  }

  const seats = map.map((member) => resolveSeat(member, bindings, blockers));
  const totalPct = seats.reduce((sum, seat) => sum + seat.pct, 0);

  if (totalPct > POOL_PCT) {
    blockers.push(
      `Pool cap over: the map totals ${totalPct}% of the ${POOL_PCT}% pool — composition refused.`,
    );
  } else if (totalPct < POOL_PCT) {
    warnings.push(
      `Only ${totalPct}% of the ${POOL_PCT}% pool is assigned to a seat — the remaining ${POOL_PCT - totalPct}% is not minted at summon and can only be minted later by a DAO vote.`,
    );
  }

  const mintable = seats.filter(
    (seat) => seat.status === "mintable" && seat.address !== null,
  );
  const byAddress = new Map<string, number>();
  for (const seat of mintable) {
    const holder = seat.address as string;
    const seen = byAddress.get(holder) ?? 0;
    if (seen === 1) {
      warnings.push(
        `More than one seat binds to ${truncatePubkey(holder)} — shares are minted per seat, so that one address's balance is the sum of them.`,
      );
    }
    byAddress.set(holder, seen + 1);
  }

  // --- org identity: validated here so a bad argument never reaches bytes ---
  const orgName = org.orgName.trim();
  if (!orgName)
    blockers.push("The DAO needs a name before it can be summoned.");
  const orgSymbol = org.orgSymbol.trim();
  if (!orgSymbol)
    blockers.push("The DAO needs a symbol before it can be summoned.");
  const quorumBps = org.quorumBps ?? 500;
  if (
    !Number.isInteger(quorumBps) ||
    quorumBps < 0 ||
    quorumBps > MAX_QUORUM_BPS
  ) {
    blockers.push(
      `Quorum ${String(quorumBps)} is outside 0–${MAX_QUORUM_BPS} basis points — the summon would encode a quorum the contract cannot mean.`,
    );
  }
  const renderer = (org.renderer ?? `0x${"00".repeat(20)}`).toLowerCase();
  if (!ADDRESS_RE.test(renderer)) {
    blockers.push(
      `Renderer “${org.renderer ?? ""}” is not a 0x address — refused rather than guessed.`,
    );
  }

  const initHolders = mintable.map((seat) => seat.address as string);
  const initShares = mintable.map((seat) => seat.shares);
  const totalShares = initShares.reduce((sum, value) => sum + value, 0n);

  let callData: string | null = null;
  if (blockers.length === 0) {
    callData = encodeSummonCalldata({
      orgName,
      orgSymbol,
      orgURI: org.orgURI ?? "",
      quorumBps,
      ragequittable: org.ragequittable ?? true,
      renderer,
      salt: summonSalt(org.nodeId),
      initHolders,
      initShares,
      initCalls: org.initCalls ?? [],
    });
  }

  return {
    seats,
    initHolders,
    initShares,
    totalPct,
    totalShares,
    cap,
    callData,
    blockers,
    warnings,
    ok: callData !== null,
  };
}

/**
 * Compose the `summon(...)` calldata from already-validated pieces.
 * Throws only on malformed hex the encoder rejects — the *policy* (caps,
 * bindings) lives in {@link composeSummon}.
 */
export function encodeSummonCalldata(input: {
  orgName: string;
  orgSymbol: string;
  orgURI: string;
  quorumBps: number;
  ragequittable: boolean;
  renderer: string;
  salt: string;
  initHolders: readonly string[];
  initShares: readonly bigint[];
  initCalls?: readonly SummonInitCall[];
}): string {
  if (input.initHolders.length !== input.initShares.length) {
    throw new Error(
      `summon-composer: ${input.initHolders.length} holders but ${input.initShares.length} share amounts (Moloch.sol:221 LengthMismatch)`,
    );
  }
  if (!BYTES32_RE.test(input.salt)) {
    throw new Error("summon-composer: salt must be 32 bytes of hex");
  }
  const initCalls = input.initCalls ?? [];
  const data = abiEncodeCall(SUMMON_SIGNATURE, [
    { kind: "string", value: input.orgName },
    { kind: "string", value: input.orgSymbol },
    { kind: "string", value: input.orgURI },
    { kind: "uint", value: BigInt(input.quorumBps) },
    { kind: "bool", value: input.ragequittable },
    { kind: "address", value: input.renderer },
    { kind: "bytes32", value: input.salt },
    {
      kind: "tuple[]",
      items: input.initHolders.map((holder) => [
        { kind: "address" as const, value: holder },
      ]),
    },
    {
      kind: "tuple[]",
      items: input.initShares.map((value) => [
        { kind: "uint" as const, value },
      ]),
    },
    {
      kind: "tuple[]",
      items: initCalls.map((call) => [
        { kind: "address" as const, value: call.target },
        { kind: "uint" as const, value: call.value },
        { kind: "bytes" as const, value: call.data },
      ]),
    },
  ] satisfies AbiField[]);
  if (!data.toLowerCase().startsWith(SUMMON_SELECTOR)) {
    throw new Error(
      `summon-composer: encoder produced selector ${data.slice(0, 10)}, expected ${SUMMON_SELECTOR}`,
    );
  }
  return data;
}

/** One sender-seam call: the summon is one tx to the Summoner factory. */
export interface SummonTx {
  to: string;
  data: string;
  /** Hex quantity; `summon` is `payable` but needs no value with no initCalls. */
  value: string;
}

/** Wrap composed bytes as the single call to send (`to` = Summoner). */
export function buildSummonTx(summoner: string, data: string): SummonTx {
  if (!ADDRESS_RE.test(summoner)) {
    throw new Error(
      `summon-composer: summoner must be a 0x address, got “${summoner}”`,
    );
  }
  return { to: summoner.toLowerCase(), data, value: "0x0" };
}

/**
 * The local wallet binding as a pubkey → address map.
 *
 * This is the one binding source this build can actually read: the relay
 * records `npub ↔ address` in `evm_identities`
 * (`migrations/0045_evm_identities.sql`, written by `POST /auth/siwe/register`,
 * `crates/buzz-relay/src/api/evm_auth.rs:298-312`) and mirrors it into this
 * browser (`features/identity/lib/siwe.ts:30` `readWalletBinding`). There is
 * no read path for *other* members' bindings today — no HTTP GET, no Nostr
 * kind (the NIP-43 member list, kind 13534, carries only `["member",
 * pubkey, role]`) — so every other seat resolves to "unbound" and is refused
 * rather than guessed. A future relay lookup plugs in as another source
 * without touching this composer.
 */
export function localBindingMap(
  binding: { pubkey: string; address: string } | null,
  map: readonly TeamMember[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (!binding) return out;
  if (!ADDRESS_RE.test(binding.address)) return out;
  const holds = map.some((member) => member.pubkey === binding.pubkey);
  if (!holds) return out;
  out.set(binding.pubkey, binding.address);
  return out;
}

/**
 * The kind:47005 `summon` receipt content (NIP-LP.md:155-161: `table` word +
 * mirrored payload, `tx` carried as a tag by the publisher).
 *
 * Carries the whole mapping — who got which seat, in which shares — so the
 * equity record on Nostr and the mint on chain stay traceable to each other.
 * `dao` is included only when the chain actually reported it (`NewDAO` log,
 * `Moloch.sol:2056`); a null DAO is stated as null, never guessed.
 */
export function summonReceiptContent(input: {
  composition: SummonComposition;
  org: SummonOrg;
  chainId: string;
  summoner: string;
  dao: string | null;
}): Record<string, unknown> {
  const { composition, org } = input;
  const holders = composition.seats
    .filter((seat) => seat.status === "mintable" && seat.address !== null)
    .map((seat) => ({
      pubkey: seat.pubkey,
      role: seat.roleSlug,
      pct: seat.pct,
      shares: seat.shares.toString(),
      address: seat.address,
    }));
  return {
    table: "summon",
    project: org.nodeId,
    summoner: input.summoner.toLowerCase(),
    chain: input.chainId,
    ...(input.dao ? { dao: input.dao.toLowerCase() } : {}),
    quorumBps: org.quorumBps ?? 500,
    ragequittable: org.ragequittable ?? true,
    salt: summonSalt(org.nodeId),
    poolPct: composition.totalPct,
    sharesPerPercent: SHARES_PER_PERCENT.toString(),
    totalShares: composition.totalShares.toString(),
    holders,
  };
}
