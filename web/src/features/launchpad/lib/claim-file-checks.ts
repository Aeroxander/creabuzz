/**
 * What the submit form refuses before anything is sent, so a submission never reports "Submitted" for something that
 * changed nothing, and never lands where nobody can act on it.
 *
 * Pure and alias-free: `claim-file-checks.test.mjs` drives it under `node --test`.
 */

import { hashText } from "@creaton/core/launchpad/work.ts";

/** A name the pages can show as written: a claim's id is its name in 32 bytes, and only plain letters read back. */
const NAME_RE = /^[\x20-\x7e]{1,32}$/;

/** Why this name cannot be used, or null. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.startsWith("0x")) {
    return "Give your work a title, up to 32 characters.";
  }
  if (!NAME_RE.test(trimmed)) {
    return "Use plain letters and numbers in the title (no accents or emoji), up to 32 characters.";
  }
  return null;
}

/**
 * Why a submission under a name this person already used cannot go ahead, or null when it can: only a submission that
 * is still open, with the very same evidence, can be sent again (to publish its evidence, or put its words right).
 * Anything else would change nothing on the chain while the form said it was submitted.
 */
export function resubmitProblem(
  existing: { record: { status: string; evidenceHash: string } } | undefined,
  evidence: string,
): string | null {
  if (!existing) return null;
  if (
    existing.record.status !== "Open" ||
    existing.record.evidenceHash.toLowerCase() !== hashText(evidence)
  ) {
    return "You already used that name for a submission. Choose a new name for new or fixed work.";
  }
  return null;
}

/**
 * Why words that match none of this budget's open work areas cannot be submitted, or null. Only work whose words are a
 * work area's can be accepted for review; anything else would wait for a manager who can never accept it.
 */
export function noAreaProblem(
  areas: readonly { checkHash: string }[],
  words: string,
): string | null {
  if (areas.length === 0) return null;
  const hash = hashText(words);
  return areas.some((area) => area.checkHash.toLowerCase() === hash)
    ? null
    : "These words match no open work area, so nobody could accept your work for review. Pick a work area above and use its words.";
}
