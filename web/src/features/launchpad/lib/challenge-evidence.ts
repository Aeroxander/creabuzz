/**
 * The evidence behind a milestone the holders can object to, kept where a holder can read it.
 *
 * The lock holds one number for it: the hash of the evidence text the team published. A hash proves a text only when the
 * text is at hand, so the team also publishes the text itself, signed, as a project update that names the lock and that
 * hash (the same update the panel's reviewers read, with the evidence hash in the place of a claim's id). The screen shows
 * a text only when it hashes to what the lock holds and its words hash to the milestone's check; a holder is never asked to
 * judge something they cannot read.
 *
 * Pure and alias-free: `challenge-evidence.test.mjs` drives it under `node --test`.
 */

import { hashText } from "@creaton/core/launchpad/work.ts";

import {
  type EvidencePacket,
  type EvidenceStanding,
  evidenceUpdateContent,
} from "./evidence.ts";

/** What the lock is given when the team publishes: the hash of the evidence text, exactly as it is published. */
export function challengeEvidenceHash(text: string): string {
  return hashText(text);
}

/** The content of the update that publishes a milestone's evidence. */
export function challengeUpdateContent(input: {
  /** The milestone's position, from 0. */
  milestone: number;
  evidence: string;
  /** The exact words of the milestone, as the lock's check was made from them. */
  check: string;
  lock: string;
}): Record<string, unknown> {
  return evidenceUpdateContent({
    name: `milestone ${input.milestone + 1}`,
    claimId: challengeEvidenceHash(input.evidence),
    mandate: input.lock,
    evidence: input.evidence,
    check: input.check,
  });
}

/**
 * What a holder can rely on for a milestone: the newest published text that hashes to the lock's evidence hash and whose
 * check words hash to the milestone's check. Nothing that does not is shown as the evidence.
 */
export function challengeEvidenceFor(
  milestone: { evidence: string | null; checkHash: string },
  packets: readonly EvidencePacket[],
  lock: string,
): EvidenceStanding {
  if (milestone.evidence === null) return { kind: "missing" };
  const want = milestone.evidence.toLowerCase();
  const named = packets.filter(
    (p) => p.mandate === lock.toLowerCase() && p.claimId === want,
  );
  if (named.length === 0) return { kind: "missing" };
  const good = named
    .filter(
      (p) =>
        hashText(p.evidence).toLowerCase() === want &&
        hashText(p.check).toLowerCase() === milestone.checkHash.toLowerCase(),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return good.length > 0
    ? { kind: "verified", packet: good[0] }
    : { kind: "mismatch", packets: named.length };
}
