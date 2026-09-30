/**
 * Milestone-attestation choices — the "no manual hashes" layer
 * (the user-journey rule: pick from lists, type only as a last resort).
 *
 * Everything a founder needs at the milestone panel is DERIVED:
 * - claim ids come from the wizard's unlock rows (`record.unlocks`) — the
 *   rows that planned the milestone in the first place — plus any claim
 *   already recorded in receipts;
 * - evidence hashes come from the launch's `claim` receipts
 *   (`{claim, evidenceHash}` payloads);
 * - tx hashes come from every receipt bound to that claim.
 *
 * Selecting a claim auto-fills the rest (`autoFill`), so the journey is one
 * dropdown. Pure — `claim-choices.test.mjs` drives it.
 */

export interface ClaimChoice {
  value: string;
  label: string;
}

export interface MilestoneChoices {
  claimOptions: ClaimChoice[];
  /** Known evidence hashes per claim (newest first), well-formed only. */
  evidenceByClaim: Record<string, string[]>;
  /** Known settlement tx hashes per claim (newest first), well-formed only. */
  txByClaim: Record<string, string[]>;
  /**
   * Schedule ids for the royalty statement — the bytes32 WORDS
   * (`claimIdWord("m1")` = `0x6d3100…`), because `schedules(bytes32)` is
   * keyed by the word, not the text.
   */
  scheduleIds: string[];
}

const EVIDENCE_RE = /^[0-9a-fA-F]{64}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

interface ReceiptLike {
  table: string;
  tx: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

function push(map: Record<string, string[]>, key: string, value: string) {
  let list = map[key];
  if (!list) {
    list = [];
    map[key] = list;
  }
  if (!list.includes(value)) list.push(value);
}

/** `"m1"` -> `0x6d3100…0` (ASCII right-padded) — the onchain schedule key. */
function scheduleWord(claim: string): string | null {
  if (
    claim.length === 0 ||
    claim.length > 32 ||
    !/^[\x20-\x7e]+$/.test(claim)
  ) {
    return null;
  }
  let hex = "";
  for (let i = 0; i < claim.length; i++) {
    hex += claim.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return `0x${hex.padEnd(64, "0")}`;
}

/**
 * Derive the milestone panel's choices from the plan + receipts. Malformed
 * values are dropped, never guessed at (the repo's honesty rule).
 */
export function milestoneChoices(
  unlocks: {
    mode: string;
    milestones: Array<{ claim: string; label: string }>;
  } | null,
  receipts: readonly ReceiptLike[],
): MilestoneChoices {
  const claimOptions: ClaimChoice[] = [];
  const seen = new Set<string>();

  if (unlocks && unlocks.mode === "milestones") {
    for (const row of unlocks.milestones) {
      if (typeof row.claim !== "string" || row.claim.trim() === "") continue;
      if (seen.has(row.claim)) continue;
      seen.add(row.claim);
      const label = row.label?.trim();
      claimOptions.push({
        value: row.claim,
        label: label ? `${row.claim} — ${label}` : row.claim,
      });
    }
  }

  const evidenceByClaim: Record<string, string[]> = {};
  const txByClaim: Record<string, string[]> = {};
  const scheduleIds: string[] = [];
  const ordered = [...receipts].sort((a, b) => b.createdAt - a.createdAt);

  for (const receipt of ordered) {
    const claim = receipt.payload.claim;
    if (typeof claim !== "string" || claim.trim() === "") continue;
    if (!seen.has(claim)) {
      seen.add(claim);
      claimOptions.push({ value: claim, label: `${claim} (recorded)` });
    }
    if (receipt.table === "claim") {
      const evidence = receipt.payload.evidenceHash;
      if (typeof evidence === "string" && EVIDENCE_RE.test(evidence)) {
        push(evidenceByClaim, claim, evidence.toLowerCase());
        const word = scheduleWord(claim);
        if (word && !scheduleIds.includes(word)) scheduleIds.push(word);
      }
    }
    if (TX_RE.test(receipt.tx)) {
      push(txByClaim, claim, receipt.tx.toLowerCase());
    }
  }

  return { claimOptions, evidenceByClaim, txByClaim, scheduleIds };
}

/**
 * The one-dropdown journey: picking a claim fills evidence + tx with the
 * newest known values (undefined when nothing is known — the picker then
 * asks the user, it never guesses).
 */
export function autoFill(
  choices: MilestoneChoices,
  claim: string,
): { evidenceHash: string | undefined; txHash: string | undefined } {
  return {
    evidenceHash: choices.evidenceByClaim[claim]?.[0],
    txHash: choices.txByClaim[claim]?.[0],
  };
}
