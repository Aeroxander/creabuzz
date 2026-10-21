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

import { type ShareRules, UNLOCK_NOTICE } from "./trading-actions.ts";

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

export function contributorStatus(
  provenance: Provenance,
  read: RulesRead,
): { start: string | null; shares: string | null; trading: string | null } {
  const start =
    provenance === "kit"
      ? "No token sale at setup: it was made by the contributor kit."
      : provenance === "record"
        ? "Its record says it started without a token sale; this page could not confirm that with the contributor kit."
        : null;
  if (read.kind === "reading") return { start, shares: null, trading: null };
  if (read.kind === "error")
    return {
      start,
      shares:
        "Its Shares' rules could not be read just now, so this page cannot say how new Shares are made or whether they can be traded.",
      trading: null,
    };
  if (read.kind === "predates")
    return {
      start,
      shares:
        "Its Shares were made before the awards-only rule: a vote can create new Shares other than as awards.",
      trading: "Its Shares were made before trading came with a 30-day notice.",
    };
  const { rules } = read;
  return {
    start,
    shares: rules.awardsOnly
      ? "New Shares come only from awards for reviewed work."
      : "A vote can create new Shares other than as awards for reviewed work.",
    trading: !rules.transfersLocked
      ? "Trading is open: Shares can be sent between wallets."
      : !rules.unlockNoticeRequired
        ? "Shares are locked, but one vote can open trading, with no notice."
        : rules.unlockAnnouncedAt === 0
          ? "Shares are locked: they cannot be sent between wallets."
          : `Opening trading was announced; a second vote can open it from ${when(rules.unlockAnnouncedAt + UNLOCK_NOTICE)}.`,
  };
}
