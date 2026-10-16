/**
 * The evidence behind a work claim, kept where a reviewer can read it.
 *
 * A claim commits to two hashes on the chain: of the evidence the contributor submitted, and of the words of the
 * acceptance check it should be judged against. A hash proves a text only when the text is at hand, so the contributor
 * also publishes the text itself, signed, as a project update that names the claim. The reviewer's screen shows that text
 * and says whether it hashes to what the claim committed to; nothing that does not is ever shown as the evidence, and a
 * reviewer cannot approve a claim whose evidence they cannot read.
 *
 * Pure and alias-free: `evidence.test.mjs` drives it under `node --test`.
 */

import { hashText } from "@creaton/core/launchpad/work.ts";

/** The most evidence text one claim carries: it travels in a signed event, and a reviewer has to read it. */
export const EVIDENCE_MAX_CHARS = 8_000;

const ZERO_WORD = `0x${"0".repeat(64)}`;

/** An update that carries a claim's evidence (structural, so the model type fits). */
export interface EvidenceUpdate {
  id: string;
  author: string;
  createdAt: number;
  body: string;
  claim?: { id: string; mandate: string; check: string };
}

export interface EvidencePacket {
  eventId: string;
  author: string;
  createdAt: number;
  claimId: string;
  mandate: string;
  evidence: string;
  check: string;
}

/** What a reviewer can rely on for one claim. */
export type EvidenceStanding =
  | { kind: "verified"; packet: EvidencePacket }
  /** Nothing was published for this claim. */
  | { kind: "missing" }
  /** Something was published for it, and none of it hashes to what the claim committed to. */
  | { kind: "mismatch"; packets: number };

/** The packets in a launch's updates: only those that name a claim. */
export function packetsOf(
  updates: readonly EvidenceUpdate[],
): EvidencePacket[] {
  const out: EvidencePacket[] = [];
  for (const update of updates) {
    if (!update.claim) continue;
    out.push({
      eventId: update.id,
      author: update.author,
      createdAt: update.createdAt,
      claimId: update.claim.id.toLowerCase(),
      mandate: update.claim.mandate.toLowerCase(),
      evidence: update.body,
      check: update.claim.check,
    });
  }
  return out;
}

/**
 * Whether a packet is the evidence this claim committed to: the evidence text hashes to the claim's evidence hash, and,
 * once the claim has its check set, the check words hash to its check hash.
 */
export function packetMatches(
  claim: { id: string; record: { evidenceHash: string; checkHash: string } },
  packet: EvidencePacket,
): boolean {
  if (packet.claimId !== claim.id.toLowerCase()) return false;
  if (hashText(packet.evidence) !== claim.record.evidenceHash.toLowerCase()) {
    return false;
  }
  const checkHash = claim.record.checkHash.toLowerCase();
  return checkHash === ZERO_WORD || hashText(packet.check) === checkHash;
}

/** The newest packet that matches, or what is wrong. */
export function evidenceFor(
  claim: { id: string; record: { evidenceHash: string; checkHash: string } },
  packets: readonly EvidencePacket[],
  mandate?: string,
): EvidenceStanding {
  const named = packets.filter(
    (p) =>
      p.claimId === claim.id.toLowerCase() &&
      (mandate === undefined || p.mandate === mandate.toLowerCase()),
  );
  if (named.length === 0) return { kind: "missing" };
  const good = named
    .filter((p) => packetMatches(claim, p))
    .sort((a, b) => b.createdAt - a.createdAt);
  return good.length > 0
    ? { kind: "verified", packet: good[0] }
    : { kind: "mismatch", packets: named.length };
}

/** The content of the update that publishes a claim's evidence. */
export function evidenceUpdateContent(input: {
  name: string;
  claimId: string;
  mandate: string;
  evidence: string;
  check: string;
}): Record<string, unknown> {
  return {
    title: `Evidence: ${input.name}`,
    body: input.evidence,
    links: urlsIn(input.evidence),
    claim: {
      id: input.claimId.toLowerCase(),
      mandate: input.mandate.toLowerCase(),
      check: input.check,
    },
  };
}

/** The https and http links in a text, for the update's link list. Capped: this is a hint, not a parser. */
export function urlsIn(text: string): string[] {
  const found = (text.match(/https?:\/\/[^\s<>"')]+/g) ?? []).map((u) =>
    u.replace(/[.,;:!?]+$/, ""),
  );
  return [...new Set(found)].slice(0, 8);
}

/** Why the evidence is not acceptable to publish, in plain words, or null. */
export function evidenceProblem(evidence: string): string | null {
  if (evidence.trim() === "")
    return "Say what you are submitting, or link to it.";
  if (evidence.length > EVIDENCE_MAX_CHARS) {
    return `That is too long to read comfortably: keep it under ${EVIDENCE_MAX_CHARS.toLocaleString("en-US")} characters and link to the rest.`;
  }
  return null;
}
