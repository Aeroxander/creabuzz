/**
 * Where one of the team's milestones stands, from the claim filed for it in the DAO's milestone panel, and what the team
 * member does next. The five stages a person sees are Submitted, Reviewing, Waiting period, Ready to unlock and Unlocked;
 * a claim that was frozen or turned down is said to be, and the milestone can be submitted again.
 *
 * Pure and alias-free: `milestone-progress.test.mjs` drives it under `node --test`.
 */

import type { ClaimView } from "@creaton/core/launchpad/work.ts";

export type MilestoneStage =
  | "not-submitted"
  | "filed"
  | "reviewing"
  | "reviewed"
  | "waiting"
  | "finish"
  | "ready"
  | "unlocked"
  | "frozen"
  | "turned-down";

/** The five steps shown, in order. */
export const MILESTONE_STEPS = [
  "Submitted",
  "Reviewing",
  "Waiting period",
  "Ready to unlock",
  "Unlocked",
] as const;

export interface MilestoneProgress {
  stage: MilestoneStage;
  /** How many of MILESTONE_STEPS are done (0 to 5); the next one is the current step. */
  done: number;
  /** One plain sentence: what is true now, and what happens next. */
  text: string;
  /** The claim this is read from, or null when nothing was submitted (or the last attempt is over). */
  claim: ClaimView | null;
}

/** Closed claims cannot be moved on, so a new one is submitted instead. */
const DEAD = new Set(["Rejected", "Recovered", "Expired"]);

/** How far a claim has got, so the most advanced one of several is the one shown. */
function rank(claim: ClaimView): number {
  switch (claim.record.status) {
    case "Paid":
      return 6;
    case "Approved":
      return 5;
    case "Open":
      return claim.project === null ? 2 : 3;
    case "Frozen":
      return 4;
    default:
      return 0; // closed claims
  }
}

/** The claim to read a milestone from: the most advanced live claim for it, else the latest closed one. */
export function claimForMilestone(
  claims: readonly ClaimView[],
  wallet: string,
  checkHash: string,
): ClaimView | null {
  const mine = claims.filter(
    (c) =>
      c.record.contributor.toLowerCase() === wallet.toLowerCase() &&
      c.record.checkHash.toLowerCase() === checkHash.toLowerCase(),
  );
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function milestoneProgress(
  claim: ClaimView | null,
  now: number,
  challengeWindow: number,
  /** The lock is asked whether this milestone is unlocked. */
  unlocked: boolean,
): MilestoneProgress {
  if (unlocked) {
    return {
      stage: "unlocked",
      done: 5,
      text: "Unlocked. These Shares are yours to move.",
      claim,
    };
  }
  if (claim === null) {
    return {
      stage: "not-submitted",
      done: 0,
      text: "Not submitted yet. Submit the evidence that this milestone was reached.",
      claim: null,
    };
  }
  const { status } = claim.record;
  if (status === "Frozen") {
    return {
      stage: "frozen",
      done: 2,
      text: "Frozen. The DAO is deciding what happens to this claim.",
      claim,
    };
  }
  if (DEAD.has(status)) {
    return {
      stage: "turned-down",
      done: 0,
      text:
        status === "Rejected"
          ? "The reviewers turned this claim down. You can submit the milestone again."
          : "This claim is closed. You can submit the milestone again.",
      claim,
    };
  }
  if (status === "Open") {
    if (claim.project === null) {
      return {
        stage: "filed",
        done: 0,
        text: "Filed, but not yet sent to the reviewers. Finish submitting it.",
        claim,
      };
    }
    if (claim.quorum !== 0 && claim.approvals >= claim.quorum) {
      return {
        stage: "reviewed",
        done: 2,
        text: "Enough reviewers approved it. Finish the review to start the waiting period.",
        claim,
      };
    }
    return {
      stage: "reviewing",
      done: 1,
      text: `With the reviewers: ${claim.approvals} of ${claim.quorum} approvals.`,
      claim,
    };
  }
  if (status === "Approved") {
    const opens = claim.record.releasedAt + challengeWindow;
    return now < opens
      ? {
          stage: "waiting",
          done: 2,
          text: `Approved. Anyone can still object until ${day(opens)}; then you can finish and unlock.`,
          claim,
        }
      : {
          stage: "finish",
          done: 3,
          text: "The waiting period is over. Finish to unlock these Shares.",
          claim,
        };
  }
  // Paid: the lock will honour it now.
  return {
    stage: "ready",
    done: 4,
    text: "Approved and past the waiting period. Unlock these Shares.",
    claim,
  };
}

/** The id for a new milestone claim: the milestone's number, with a suffix when an earlier try used it. */
export function milestoneClaimId(
  index: number,
  taken: readonly string[],
): string {
  const base = `milestone-${index + 1}`;
  const used = new Set(taken.map((t) => t.toLowerCase()));
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return `${base}-${Date.now() % 100_000}`;
}
