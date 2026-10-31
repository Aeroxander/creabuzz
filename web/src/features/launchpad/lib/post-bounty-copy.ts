/**
 * What a bounty on a post says about itself, in plain words (N2). One sentence per stage, so the page and its tests
 * agree; amounts, dates and names come formatted from the caller.
 */

import {
  backingPercent,
  type PostBountyRecord,
  type PostBountyStage,
  type PostClaimView,
} from "@creaton/core/launchpad/openBounty.ts";

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
      return bounty.appeal.state === "refused" ||
        bounty.appeal.state === "upheld"
        ? "The court did not uphold the work in time. Everyone can take their money back."
        : "No work kept a majority in time. Everyone can take their money back.";
    case "window":
      return `Nothing was agreed by the deadline. Anyone whose work is here can appeal to the court until ${words.date(stage.until)}; then everyone can take their money back.`;
    case "appealing":
      return `${claimantOf(claims, stage.claim, words.who)} appealed to the court. The money stays here until it rules.`;
    case "upheld":
      return `The court found ${claimantOf(claims, stage.claim, words.who)}'s work matches the words. Anyone can pay it now, until ${words.date(stage.payUntil)}.`;
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

/**
 * Beside Add money: who decides (the work most of the money backs), and when the money can come back. With a court,
 * refunds wait for the appeal window after the deadline once work was filed, and while an appeal is open, even past
 * the backstop day (the contract's `_refundsOpen`).
 */
export function addMoneyLine(
  deadline: string,
  refundsFrom: string,
  court: boolean,
): string {
  return [
    "The work most of the money backs for nine days is paid.",
    `If none is, you can take yours back after ${deadline}, or from ${refundsFrom} if a piece of work is still running then.`,
    court
      ? "If work was filed, that waits three more days in case it goes to the court, and for as long as the court has it."
      : null,
    "If you back a piece of work, this adds to your backing.",
  ]
    .filter((part) => part !== null)
    .join(" ");
}
