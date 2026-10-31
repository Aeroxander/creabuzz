/**
 * The story behind one award (the contributor plan's F2): who contributed, what they delivered, what award happened,
 * when, and where the record is. Each part says where it comes from and is shown only as far as its source goes:
 *
 * - when: the time of the block the award ran in, read from the chain; unknown when the block could not be read;
 * - the review: how many reviewers approved, of how many the claim needed, from the claim on the chain; unknown when
 *   the claim is not in what the page read;
 * - what they delivered: the contributor's own evidence, signed and published beside the claim, shown only when it
 *   hashes to what the claim committed to (`lib/evidence.ts`), so a later edit or someone else's text is never shown
 *   as theirs.
 *
 * The award itself (its Shares, and whether they arrived) is `lib/contributions.ts`. Pure and alias-free:
 * `contribution-story.test.mjs` drives it under `node --test`.
 */

import { type EvidencePacket, evidenceFor } from "./evidence.ts";
import type { ClaimView } from "@creaton/core/launchpad/work.ts";

/**
 * How far the contributor's evidence could be checked: `verified` (it is the evidence the claim committed to),
 * `mismatch` (what was published is not), `missing` (the whole history was read and nothing was published), `not-found`
 * (nothing in the part of the history that was read), `unreadable` (the read failed), `reading` (it has not answered
 * yet), `unknown` (the claim itself was not read). Only `missing` says nothing was published.
 */
type EvidenceState =
  | "verified"
  | "mismatch"
  | "missing"
  | "not-found"
  | "unreadable"
  | "reading"
  | "unknown";

export interface AwardStory {
  /** When the award ran (unix seconds); null when its block could not be read. */
  at: number | null;
  /** The claim's review on the chain; null when the claim is not in what was read. */
  review: { approvals: number; quorum: number } | null;
  /** The contributor's evidence, when it is the one the claim committed to. */
  evidence: string | null;
  evidenceState: EvidenceState;
}

/** The key a claim is found under: its budget and its id. */
export const storyKey = (mandate: string, claimId: string) =>
  `${mandate.toLowerCase()}:${claimId.toLowerCase()}`;

export function storyFor(
  award: { budget: string; claimId: string; blockNumber: number | null },
  sources: {
    /** Block number → its time, for the blocks that could be read. */
    times: ReadonlyMap<number, number>;
    /** The claims the page read, by `storyKey`. */
    claims: ReadonlyMap<
      string,
      Pick<ClaimView, "id" | "record" | "approvals" | "quorum">
    >;
    packets: readonly EvidencePacket[];
    /** How the evidence read went: absence counts as "nothing published" only when it was complete and answered. */
    read?: { loading: boolean; error: boolean; incomplete: boolean };
  },
): AwardStory {
  const at =
    award.blockNumber === null
      ? null
      : (sources.times.get(award.blockNumber) ?? null);
  const claim = sources.claims.get(storyKey(award.budget, award.claimId));
  if (!claim)
    return { at, review: null, evidence: null, evidenceState: "unknown" };
  const standing = evidenceFor(claim, sources.packets, award.budget);
  const read = sources.read ?? {
    loading: false,
    error: false,
    incomplete: false,
  };
  const evidenceState: EvidenceState =
    standing.kind !== "missing"
      ? standing.kind
      : read.loading
        ? "reading"
        : read.error
          ? "unreadable"
          : read.incomplete
            ? "not-found"
            : "missing";
  return {
    at,
    review: { approvals: claim.approvals, quorum: claim.quorum },
    evidence: standing.kind === "verified" ? standing.packet.evidence : null,
    evidenceState,
  };
}

/** The first web link in a text, whole, so a shortened text never leaves a broken one. Only http and https. */
export function firstLink(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')]+/);
  return match ? match[0].replace(/[.,;:!?]+$/, "") : null;
}

/** The evidence, shortened for a list: whole up to `max` characters, else cut at a word with an ellipsis. */
export function shortEvidence(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
