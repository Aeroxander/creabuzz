/**
 * What a bounty on a post says about itself, in plain words (N2). One sentence per stage, so the page and its tests
 * agree; amounts, dates and names come formatted from the caller.
 */

import {
  backingPercent,
  type PostBountyRecord,
  type PostBountyStage,
  type PostClaimView,
} from "./open-bounty.ts";

export interface PostBountyWords {
  money: (units: bigint) => string;
  date: (seconds: number) => string;
  who: (address: string) => string;
}

/** Who made claim `claim`, or a neutral word when it is not among those read. */
function claimantOf(
  claims: readonly PostClaimView[],
  claim: number,
  who: (address: string) => string,
): string {
  const found = claims.find((c) => c.claim === claim);
  return found ? who(found.claimant) : "Someone";
}

export function postBountyLine(
  stage: PostBountyStage,
  bounty: PostBountyRecord,
  claims: readonly PostClaimView[],
  words: PostBountyWords,
): string {
  switch (stage.kind) {
    case "paid":
      return `Paid ${words.money(bounty.total)} to ${claimantOf(claims, stage.claim, words.who)}.`;
    case "refunds":
      return "No work kept a majority in time. Everyone can take their money back.";
    case "payable":
      return `${claimantOf(claims, stage.claim, words.who)}'s work kept its backing. Anyone can pay it now.`;
    case "agreeing":
      return `Most of the money backs ${claimantOf(claims, stage.claim, words.who)}'s work. If it stays that way, it is paid on ${words.date(stage.payableAt)}. No new money until then.`;
    case "holding":
      return `Agreed. ${claimantOf(claims, stage.claim, words.who)} is paid on ${words.date(stage.payableAt)} unless the backing drops.`;
    case "open":
      return `Takes money and work until ${words.date(bounty.deadline)}. The work most of the money backs for nine days is paid.`;
  }
}

/** How much of the counting money backs a claim, or that it was withdrawn. */
export function claimShareLine(claim: PostClaimView, counting: bigint): string {
  if (!claim.open) return "Withdrawn";
  return `${backingPercent(claim.backing, counting)}% of the money that counts backs this`;
}

/** Evidence that is a plain web address is shown as a link; anything else as text. */
export function evidenceLink(evidence: string): string | null {
  const text = evidence.trim();
  if (!/^https?:\/\/\S+$/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Claims in the order people need them: the most backed first, then the newest; withdrawn ones last. */
export function claimsInOrder(
  claims: readonly PostClaimView[],
): PostClaimView[] {
  return [...claims].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.backing !== b.backing) return a.backing > b.backing ? -1 : 1;
    return b.claim - a.claim;
  });
}
