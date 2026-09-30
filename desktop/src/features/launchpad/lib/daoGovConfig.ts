/**
 * Majeur governance-config read model — the numbers behind the D6 quorum
 * math (`docs/agentic-governance-design.md` D6).
 *
 * Sources of truth: `contracts/lib/majeur/src/Moloch.sol:34-45` — the public
 * settings behind `state()`'s gates. Every value is `0 = off` (a known
 * configuration, rendered as "off"), and an UNREAD slot stays `null` — the
 * panel says "per DAO config" there. Never invent numbers (D6's honesty
 * rule): the getters win over any advertised record params, and a slot the
 * chain did not answer for is not guessed.
 *
 * Encoding rides `lib/evmCalls.ts` (selectors derived and pinned to
 * `cast sig` in `daoGovConfig.test.mjs`). Reads go through the `evm_call`
 * Tauri IPC command via the injected caller.
 */

import { decodeUint256 } from "@/features/launchpad/lib/chainRpc";
import {
  encodeFunctionData,
  selectorOf,
} from "@/features/launchpad/lib/evmCalls";

// ---------------------------------------------------------------------------
// Canonical signatures and selectors (cross-checked with `cast sig`)
// ---------------------------------------------------------------------------

/** `quorumBps()` — dynamic quorum vs snapshot supply (BPS, 0 = off). */
export const SIGNATURE_QUORUM_BPS = "quorumBps()";
/** `quorumAbsolute()` — minimum total turnout FOR+AGAINST+ABSTAIN (0 = off). */
export const SIGNATURE_QUORUM_ABSOLUTE = "quorumAbsolute()";
/** `minYesVotesAbsolute()` — absolute YES (FOR) floor (0 = off). */
export const SIGNATURE_MIN_YES = "minYesVotesAbsolute()";
/** `proposalTTL()` — proposal expiry in seconds (0 = off). */
export const SIGNATURE_PROPOSAL_TTL = "proposalTTL()";
/** `timelockDelay()` — success→execution delay in seconds (0 = off). */
export const SIGNATURE_TIMELOCK_DELAY = "timelockDelay()";

/** Selector of {@link SIGNATURE_QUORUM_BPS} (`cast`: `0xcd2ddd0c`). */
export const SELECTOR_QUORUM_BPS = selectorOf(SIGNATURE_QUORUM_BPS);
/** Selector of {@link SIGNATURE_QUORUM_ABSOLUTE} (`cast`: `0x6a34d91a`). */
export const SELECTOR_QUORUM_ABSOLUTE = selectorOf(SIGNATURE_QUORUM_ABSOLUTE);
/** Selector of {@link SIGNATURE_MIN_YES} (`cast`: `0x8ab8c683`). */
export const SELECTOR_MIN_YES = selectorOf(SIGNATURE_MIN_YES);
/** Selector of {@link SIGNATURE_PROPOSAL_TTL} (`cast`: `0x59a342d6`). */
export const SELECTOR_PROPOSAL_TTL = selectorOf(SIGNATURE_PROPOSAL_TTL);
/** Selector of {@link SIGNATURE_TIMELOCK_DELAY} (`cast`: `0xeef09bad`). */
export const SELECTOR_TIMELOCK_DELAY = selectorOf(SIGNATURE_TIMELOCK_DELAY);

// ---------------------------------------------------------------------------
// Read calldata builders
// ---------------------------------------------------------------------------

/** ABI-encode `quorumBps()`. */
export function encodeQuorumBps(): string {
  return encodeFunctionData(SIGNATURE_QUORUM_BPS, [], []);
}

/** ABI-encode `quorumAbsolute()`. */
export function encodeQuorumAbsolute(): string {
  return encodeFunctionData(SIGNATURE_QUORUM_ABSOLUTE, [], []);
}

/** ABI-encode `minYesVotesAbsolute()`. */
export function encodeMinYes(): string {
  return encodeFunctionData(SIGNATURE_MIN_YES, [], []);
}

/** ABI-encode `proposalTTL()`. */
export function encodeProposalTtl(): string {
  return encodeFunctionData(SIGNATURE_PROPOSAL_TTL, [], []);
}

/** ABI-encode `timelockDelay()`. */
export function encodeTimelockDelay(): string {
  return encodeFunctionData(SIGNATURE_TIMELOCK_DELAY, [], []);
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/**
 * The DAO's advertised governance settings. `null` = the chain did not answer
 * (or there is no DAO to read) — the panel renders "per DAO config", never a
 * guessed number. `0` values are the documented `off` switches.
 */
export interface DaoGovParams {
  /** Quorum vs snapshot supply, BPS (0 = off). */
  quorumBps: number | null;
  /** Minimum total turnout (0 = off). */
  quorumAbsolute: bigint | null;
  /** Absolute YES floor (0 = off). */
  minYesAbsolute: bigint | null;
  /** Proposal expiry in seconds (0 = off). */
  ttlSeconds: number | null;
  /** Timelock delay in seconds (0 = off). */
  timelockSeconds: number | null;
}

/** The five getters, slot-keyed (each returns one 32-byte word). */
export const DAO_GOV_GETTERS = [
  { slot: "quorumBps", data: () => encodeQuorumBps() },
  { slot: "quorumAbsolute", data: () => encodeQuorumAbsolute() },
  { slot: "minYesAbsolute", data: () => encodeMinYes() },
  { slot: "ttlSeconds", data: () => encodeProposalTtl() },
  { slot: "timelockSeconds", data: () => encodeTimelockDelay() },
] as const satisfies readonly {
  slot: keyof DaoGovParams;
  data: () => string;
}[];

/**
 * Load the governance settings through an injected `eth_call`-shaped caller
 * (`(data) => returnData` against the DAO). A getter that fails or returns
 * garbage leaves its own slot `null` — partial honesty beats a fabricated
 * summary. `quorumBps`/`ttlSeconds`/`timelockSeconds` fit their onchain
 * widths (uint16/uint64) in a JS number.
 */
export async function loadDaoGovParams(
  call: (data: string) => Promise<string>,
): Promise<DaoGovParams> {
  const results = await Promise.allSettled(
    DAO_GOV_GETTERS.map((getter) => call(getter.data())),
  );
  const params: DaoGovParams = {
    quorumBps: null,
    quorumAbsolute: null,
    minYesAbsolute: null,
    ttlSeconds: null,
    timelockSeconds: null,
  };
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const getter = DAO_GOV_GETTERS[index];
    let word: bigint;
    try {
      word = decodeUint256(result.value);
    } catch {
      return;
    }
    switch (getter.slot) {
      case "quorumBps":
        params.quorumBps = Number(word);
        break;
      case "quorumAbsolute":
        params.quorumAbsolute = word;
        break;
      case "minYesAbsolute":
        params.minYesAbsolute = word;
        break;
      case "ttlSeconds":
        params.ttlSeconds = Number(word);
        break;
      case "timelockSeconds":
        params.timelockSeconds = Number(word);
        break;
    }
  });
  return params;
}
