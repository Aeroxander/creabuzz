/**
 * Milestone/royalty choices — the "no manual hashes" layer (web's
 * `claim-choices.ts` parity). Everything a user needs is DERIVED from the
 * launch's receipts; selecting a claim auto-fills the rest (`autoFill`).
 * Pure — `claimChoices.test.mjs` drives it.
 */

export interface ClaimChoice {
  value: string;
  label: string;
}

export interface MilestoneChoices {
  claimOptions: ClaimChoice[];
  evidenceByClaim: Record<string, string[]>;
  txByClaim: Record<string, string[]>;
  /**
   * Schedule ids for the royalty statement — the bytes32 WORDS
   * (`0x6d3100…` for `"m1"`), because `schedules(bytes32)` is keyed by the
   * word, not the text.
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
 * Derive the milestone choices from the plan + receipts. Malformed values
 * are dropped, never guessed at.
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
 * newest known values (undefined when nothing is known — never guessed).
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
