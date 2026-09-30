/**
 * The D6 quorum line's live numbers — web parity with desktop's
 * `lib/daoGovConfig.ts`: read majeur's public config getters over the
 * `../chain.ts` `ethCall` seam. Unreadable slots stay null and the summary
 * says "per DAO config" (never invented numbers — the design's honesty rule).
 */

import { ethCall } from "../chain.ts";
import type { QuorumParams } from "./governance-view.ts";

// majeur's public getters, pinned to `cast sig` (desktop's daoGovConfig
// parity — these literals are the drift guard).
// quorumBps()
export const SELECTOR_QUORUM_BPS = "0xcd2ddd0c";
// quorumAbsolute()
export const SELECTOR_QUORUM_ABSOLUTE = "0x6a34d91a";
// minYesVotesAbsolute()
export const SELECTOR_MIN_YES = "0x8ab8c683";
// proposalTTL()
export const SELECTOR_PROPOSAL_TTL = "0x59a342d6";
// timelockDelay()
export const SELECTOR_TIMELOCK = "0xeef09bad";
// config() — the bump counter `bumpConfig` increments (the offline
// proposal-id input for an agent-draft's counter-sign).
export const SELECTOR_CONFIG = "0x79502c55";

async function readU256(
  endpoint: string,
  dao: string,
  data: string,
): Promise<bigint | null> {
  try {
    return BigInt(await ethCall(endpoint, dao, data));
  } catch {
    return null;
  }
}

function seconds(value: bigint | null): string | null {
  if (value === null || value === 0n) return null;
  const days = Number(value) / 86_400;
  return days >= 1 ? `${Math.round(days * 10) / 10}d` : `${value}s`;
}

/** Exported for the drift-guard tests. */
export const decode = { seconds };

/**
 * Read the DAO's live governance config for the quorum summary. Each slot
 * fails independently (null = "per DAO config" in the copy).
 */
export async function fetchDaoGovConfig(
  endpoint: string,
  dao: string,
): Promise<QuorumParams & { config: bigint | null }> {
  const [
    quorumBps,
    quorumAbsolute,
    minYes,
    proposalTtl,
    timelockDelay,
    config,
  ] = await Promise.all([
    readU256(endpoint, dao, SELECTOR_QUORUM_BPS),
    readU256(endpoint, dao, SELECTOR_QUORUM_ABSOLUTE),
    readU256(endpoint, dao, SELECTOR_MIN_YES),
    readU256(endpoint, dao, SELECTOR_PROPOSAL_TTL),
    readU256(endpoint, dao, SELECTOR_TIMELOCK),
    readU256(endpoint, dao, SELECTOR_CONFIG),
  ]);
  return {
    // 0 on chain means "off" — the summary then falls back to the absolute
    // quorum or to "per DAO config", matching majeur's semantics.
    quorumBps: quorumBps === null ? null : Number(quorumBps),
    minYes: minYes === null ? null : Number(minYes),
    proposalTtl: seconds(proposalTtl),
    proposalTtlSeconds: proposalTtl,
    timelockDelay: seconds(timelockDelay),
    config,
    ...(quorumAbsolute !== null
      ? { quorumAbsolute: Number(quorumAbsolute) }
      : {}),
  };
}
