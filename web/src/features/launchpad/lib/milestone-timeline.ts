/**
 * The public story of each milestone: what the team agreed to, how many of its tokens that affects, where the review
 * stands, what evidence was submitted, who decided what, when the challenge window ends and whether the tokens have been
 * released. It is the same for everyone who opens the project, not only for the connected team wallet, so a backer sees
 * what a team member sees (minus the buttons).
 *
 * Pure and alias-free: `milestone-timeline.test.mjs` drives it under `node --test`. It reads only what the page already
 * holds: the launch record's milestones, the milestone panel's claims, the lock's tranches, the reviewers' verdicts and
 * the evidence the team published.
 */

import type { ClaimView } from "@creaton/core/launchpad/work.ts";
import { hashText } from "@creaton/core/launchpad/work.ts";

import { type EvidencePacket, evidenceFor } from "./evidence.ts";
import {
  MILESTONE_STEPS,
  type MilestoneStage,
  milestoneProgress,
} from "./milestone-progress.ts";

export { MILESTONE_STEPS };

/** One milestone as the launch record writes it. */
export interface PlannedMilestone {
  /** The words the milestone is judged against. */
  label: string;
  /** Its share of the milestone allocation, percent. */
  percent: number | null;
}

/** One team member's tranche for one milestone, as the lock reports it. */
export interface Tranche {
  index: number;
  amount: bigint;
  checkHash: string;
  unlocked: boolean;
  forfeited: boolean;
  reachedAt: number | null;
}

/** The DAO's milestone panel, as far as the timeline needs it. */
export interface Panel {
  address: string;
  reviewers: readonly { address: string }[];
  quorum: number;
  challengeWindow: number;
  claims: readonly ClaimView[];
}

export interface Verdict {
  reviewer: string;
  approve: boolean;
}

export type TimelineStage = MilestoneStage | "agreed" | "given-up";

export interface ReviewerVerdict {
  reviewer: string;
  verdict: "approved" | "objected" | "none" | "unknown";
}

export interface TimelineEntry {
  index: number;
  label: string;
  percent: number | null;
  /** The tokens this milestone holds back, across the team members it applies to; null before there is a lock to ask. */
  tokens: bigint | null;
  /** How many team members have tokens behind this milestone. */
  holders: number;
  stage: TimelineStage;
  /** How many of {@link MILESTONE_STEPS} are done. */
  done: number;
  /** One plain sentence: what is true now. */
  headline: string;
  claimId: string | null;
  approvals: number;
  objections: number;
  quorum: number;
  /** When anyone can no longer object: set while the claim waits out its challenge window. */
  challengeEndsAt: number | null;
  /** When the tokens were released, if they have been and the time could be read. */
  releasedAt: number | null;
  /** The evidence the team published for the claim, shown only when it matches what the claim committed to on the chain. */
  evidence: { text: string; check: string } | null;
  /** A claim was filed and no matching evidence could be found (the reviewers cannot approve what they cannot read). */
  evidenceMissing: boolean;
  /** Every reviewer on the panel and what they said about this claim. */
  verdicts: ReviewerVerdict[];
  /** Claims for this milestone that were turned down or closed before the current one. */
  earlierAttempts: number;
  /** Team members whose tokens for this milestone are unlocked, of those it applies to. */
  unlockedFor: { unlocked: number; of: number };
}

export interface TimelineSummary {
  reached: number;
  total: number;
  /** Tokens still held back behind milestones that are not reached. */
  heldBack: bigint;
  /** Tokens released by reached milestones. */
  released: bigint;
  /** Tokens the DAO gave up (burned, never released). */
  givenUp: bigint;
}

const DEAD = new Set(["Rejected", "Recovered", "Expired"]);

const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** How far a claim has got, so the most advanced live one is the one shown. */
function rank(claim: ClaimView): number {
  switch (claim.record.status) {
    case "Paid":
      return 6;
    case "Approved":
      return 5;
    case "Frozen":
      return 4;
    case "Open":
      return claim.project === null ? 2 : 3;
    default:
      return 0;
  }
}

function headlineFor(
  stage: TimelineStage,
  input: {
    approvals: number;
    objections: number;
    quorum: number;
    challengeEndsAt: number | null;
    releasedAt: number | null;
    status: string | null;
    unlockedFor: { unlocked: number; of: number };
  },
): string {
  switch (stage) {
    case "agreed":
      return "Agreed. The reviewers judge it once the project has launched.";
    case "not-submitted":
      return "Not submitted yet.";
    case "filed":
      return "Filed, but not yet sent to the reviewers.";
    case "reviewing":
      return `With the reviewers: ${input.approvals} of ${input.quorum} approved${input.objections > 0 ? `, ${input.objections} objected` : ""}.`;
    case "reviewed":
      return "Enough reviewers approved it. The waiting period starts once the review is finished.";
    case "waiting":
      return `Approved by the reviewers. Anyone can still object until ${input.challengeEndsAt ? day(input.challengeEndsAt) : "the waiting period ends"}.`;
    case "finish":
      return "The waiting period is over. The team can finish the release now.";
    case "ready":
      return "Approved and past the waiting period. The release can be claimed now.";
    case "unlocked":
      return input.unlockedFor.of > 1 &&
        input.unlockedFor.unlocked < input.unlockedFor.of
        ? `Unlocked for ${input.unlockedFor.unlocked} of ${input.unlockedFor.of} team members.`
        : `Unlocked${input.releasedAt ? ` on ${day(input.releasedAt)}` : ""}. These tokens can now be moved.`;
    case "frozen":
      return "A DAO vote froze this claim. Nothing unlocks while it is frozen.";
    case "turned-down":
      return input.status === "Rejected"
        ? "The reviewers turned this claim down. The team can submit the milestone again."
        : "This claim is closed. The team can submit the milestone again.";
    case "given-up":
      return "The DAO gave these tokens up: they were burned and never released.";
  }
}

/**
 * Build the timeline. `events` carries what the record read already knows: every reviewer's verdict by claim and the
 * lock's tranches per team member. With no panel (the project has not launched) every milestone is "agreed".
 */
export function buildTimeline(input: {
  milestones: readonly PlannedMilestone[];
  panel: Panel | null;
  /** Each team member's tranches. */
  tranches: readonly (readonly Tranche[])[];
  /** Reviewers' verdicts by lower-case `mandate:claim` key; undefined when they could not be read. */
  verdicts: ReadonlyMap<string, readonly Verdict[]> | undefined;
  packets: readonly EvidencePacket[];
  now: number;
}): { entries: TimelineEntry[]; summary: TimelineSummary } {
  const { milestones, panel, packets, now } = input;
  const entries: TimelineEntry[] = milestones.map((planned, index) => {
    const mine = input.tranches.flatMap((person) =>
      person.filter((t) => t.index === index),
    );
    const checkHash = (
      mine[0]?.checkHash ?? hashText(planned.label)
    ).toLowerCase();
    const unlockedCount = mine.filter((t) => t.unlocked).length;
    const unlockedFor = { unlocked: unlockedCount, of: mine.length };
    const allUnlocked = mine.length > 0 && unlockedCount === mine.length;
    const allGivenUp = mine.length > 0 && mine.every((t) => t.forfeited);
    const tokens =
      mine.length > 0 ? mine.reduce((sum, t) => sum + t.amount, 0n) : null;
    const releasedAt = allUnlocked
      ? Math.max(0, ...mine.map((t) => t.reachedAt ?? 0)) || null
      : null;

    const claims = (panel?.claims ?? []).filter(
      (c) => c.record.checkHash.toLowerCase() === checkHash,
    );
    const live = claims
      .filter((c) => !DEAD.has(c.record.status))
      .sort((a, b) => rank(b) - rank(a))[0];
    const latestDead = claims.filter((c) => DEAD.has(c.record.status)).pop();
    const claim = live ?? latestDead ?? null;
    const earlierAttempts = claims.filter(
      (c) => DEAD.has(c.record.status) && c !== claim,
    ).length;

    let stage: TimelineStage;
    let done: number;
    let challengeEndsAt: number | null = null;
    if (allGivenUp) {
      stage = "given-up";
      done = 0;
    } else if (!panel) {
      stage = allUnlocked ? "unlocked" : "agreed";
      done = allUnlocked ? 5 : 0;
    } else {
      const progress = milestoneProgress(
        claim,
        now,
        panel.challengeWindow,
        allUnlocked,
      );
      stage = progress.stage;
      done = progress.done;
      if (claim && claim.record.status === "Approved") {
        challengeEndsAt = claim.record.releasedAt + panel.challengeWindow;
      }
    }

    // Who said what: every reviewer on the panel, so a reviewer who has not decided is visible as not having decided.
    const said =
      claim && panel
        ? input.verdicts?.get(`${panel.address}:${claim.id}`.toLowerCase())
        : undefined;
    const verdicts: ReviewerVerdict[] = (panel?.reviewers ?? []).map((r) => {
      if (!claim) return { reviewer: r.address, verdict: "none" };
      if (input.verdicts === undefined) {
        return { reviewer: r.address, verdict: "unknown" };
      }
      const found = (said ?? []).find(
        (v) => v.reviewer.toLowerCase() === r.address.toLowerCase(),
      );
      return {
        reviewer: r.address,
        verdict: found ? (found.approve ? "approved" : "objected") : "none",
      };
    });

    const standing =
      claim && panel ? evidenceFor(claim, packets, panel.address) : null;
    const evidence =
      standing?.kind === "verified"
        ? { text: standing.packet.evidence, check: standing.packet.check }
        : null;
    const live2 = claim !== null && stage !== "turned-down";
    const approvals = claim?.approvals ?? 0;
    const objections = claim?.objections ?? 0;
    const quorum = claim?.quorum ?? panel?.quorum ?? 0;

    return {
      index,
      label: planned.label,
      percent: planned.percent,
      tokens,
      holders: mine.length,
      stage,
      done,
      headline: headlineFor(stage, {
        approvals,
        objections,
        quorum,
        challengeEndsAt,
        releasedAt,
        status: claim?.record.status ?? null,
        unlockedFor,
      }),
      claimId: claim?.id ?? null,
      approvals,
      objections,
      quorum,
      challengeEndsAt,
      releasedAt,
      evidence,
      evidenceMissing:
        live2 &&
        standing !== null &&
        standing.kind !== "verified" &&
        stage !== "unlocked",
      verdicts,
      earlierAttempts,
      unlockedFor,
    };
  });

  const summary: TimelineSummary = {
    reached: entries.filter((e) => e.stage === "unlocked").length,
    total: entries.length,
    heldBack: 0n,
    released: 0n,
    givenUp: 0n,
  };
  for (const person of input.tranches) {
    for (const t of person) {
      if (t.forfeited) summary.givenUp += t.amount;
      else if (t.unlocked) summary.released += t.amount;
      else summary.heldBack += t.amount;
    }
  }
  return { entries, summary };
}
