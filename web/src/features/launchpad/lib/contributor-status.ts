/**
 * What a contributor project's header may say about it (the contributor plan's C3), each line only as far as its
 * source goes:
 *
 * - how it started: "no token sale at setup" when the contributor kit's own launch event names this DAO; when the kit
 *   is not known here or does not name it, only that its record says so;
 * - new Shares: "only from awards" when the Shares themselves say `awardsOnly`; otherwise what they do say, or that
 *   it could not be read, or that they predate the rule;
 * - trading: what the Shares' lock says now, with an announced opening given by its date (the chain alone decides when
 *   that date has passed, so no clock is read here).
 *
 * Pure and alias-free: `contributor-status.test.mjs` drives it under `node --test`.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  type ShareRules,
  UNLOCK_NOTICE,
} from "@creaton/core/launchpad/tradingActions.ts";

/**
 * `ContributorProjectLaunched(address indexed founder, address indexed dao, address indexed budget, bytes32 salt,
 * uint256 projects)`, emitted by the contributor kit once for each project it makes (D84's form).
 */
export const TOPIC_CONTRIBUTOR_LAUNCHED = `0x${bytesToHex(
  keccak_256(
    utf8ToBytes(
      "ContributorProjectLaunched(address,address,address,bytes32,uint256)",
    ),
  ),
)}`;

/**
 * `ContributorProjectLaunchedV2(address indexed founder, address indexed dao, address indexed market, address budget,
 * address policy, address quote, uint256 lotSize)`, emitted by the weekly-sale kit for a project it makes with its market.
 * The founder and the DAO are indexed in the same places as in the plain kit's event.
 */
export const TOPIC_CONTRIBUTOR_LAUNCHED_V2 = `0x${bytesToHex(
  keccak_256(
    utf8ToBytes(
      "ContributorProjectLaunchedV2(address,address,address,address,address,address,uint256)",
    ),
  ),
)}`;

/**
 * `ContributorProjectLaunchedV3(address indexed founder, address indexed dao, address indexed market, address budget,
 * address policy, address quote, uint256 lotSize, address pool)`, emitted by the pool kit for a project it makes with its
 * market and its backing pool. The founder and the DAO are indexed in the same places. It is not in `KIT_LAUNCH_TOPICS`,
 * which the pinned list of the plain and weekly-sale kits' events stays; the pool kit is read with its own address.
 */
export const TOPIC_CONTRIBUTOR_LAUNCHED_V3 = `0x${bytesToHex(
  keccak_256(
    utf8ToBytes(
      "ContributorProjectLaunchedV3(address,address,address,address,address,address,uint256,address)",
    ),
  ),
)}`;

/**
 * Every launch event a named kit may have emitted for a project. The weekly-sale kit emits the second for its own launch
 * and the first when its plain launch is called, so a project counts as made by the kit on either.
 */
export const KIT_LAUNCH_TOPICS: readonly string[] = [
  TOPIC_CONTRIBUTOR_LAUNCHED,
  TOPIC_CONTRIBUTOR_LAUNCHED_V2,
];

/**
 * The kit's launch logs for `dao` (its word, `addressTopic`), whichever event the kit emitted: one read per event, in
 * order, bounded by the list above. `read` takes the log topics (event, founder, dao); a read that fails fails the whole
 * answer, so a node error is never taken for "the kit did not make it".
 */
export async function kitLaunchLogs<T>(
  read: (topics: (string | null)[]) => Promise<readonly T[]>,
  daoTopic: string,
): Promise<T[]> {
  const found: T[] = [];
  for (const event of KIT_LAUNCH_TOPICS) {
    found.push(...(await read([event, null, daoTopic])));
  }
  return found;
}

/** How the project's start was checked: by the kit's event, only by its record, or not yet. */
export type Provenance = "kit" | "record" | "reading";

/** What the Shares' rules read gave: their rules, that they predate them, an error, or nothing yet. */
export type RulesRead =
  | { kind: "rules"; rules: ShareRules }
  | { kind: "predates" }
  | { kind: "error" }
  | { kind: "reading" };

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

/** One header chip: a short label, and whether it is a plain fact or something to be careful about. */
export interface StatusChip {
  label: string;
  /** "caution": unchecked, unreadable, or something one vote can change. */
  tone: "plain" | "caution";
}

const plain = (label: string): StatusChip => ({ label, tone: "plain" });
const caution = (label: string): StatusChip => ({ label, tone: "caution" });

export function contributorStatus(
  provenance: Provenance,
  read: RulesRead,
): {
  start: StatusChip | null;
  shares: StatusChip | null;
  trading: StatusChip | null;
} {
  const start =
    provenance === "kit"
      ? plain("No token sale")
      : provenance === "record"
        ? caution("No token sale (not checked)")
        : null;
  if (read.kind === "reading") return { start, shares: null, trading: null };
  if (read.kind === "error")
    return {
      start,
      shares: caution("Couldn't check its Shares"),
      trading: null,
    };
  if (read.kind === "predates")
    return {
      start,
      shares: caution("A vote can create Shares"),
      trading: caution("One vote can make Shares sellable"),
    };
  const { rules } = read;
  return {
    start,
    shares: rules.awardsOnly
      ? plain("New Shares only for reviewed work")
      : caution("A vote can create Shares"),
    trading: !rules.transfersLocked
      ? plain("Shares can be sold")
      : !rules.unlockNoticeRequired
        ? caution("One vote can make Shares sellable")
        : rules.unlockAnnouncedAt === 0
          ? plain("Shares can't be sold")
          : caution(
              `Can become sellable from ${when(rules.unlockAnnouncedAt + UNLOCK_NOTICE)}`,
            ),
  };
}
