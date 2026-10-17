/**
 * What a milestone that holders can object to says about itself, and what each person can do about it.
 *
 * `challengeStage` (in `@creaton/core`) says where a milestone is; this turns that into the words a screen shows and the
 * list of things the connected person may do next, in one place, so the Milestones tab, the DAO's front page and Home agree.
 * Every rule here mirrors the contract's (who may object, who may vote, when the bond comes back): the screen never offers
 * a button the contract would refuse.
 *
 * Pure and alias-free: `challenge-copy.test.mjs` drives it under `node --test`.
 */

import type {
  ChallengeMilestone,
  ChallengeStage,
  ChallengeTerms,
} from "./milestone-challenge.ts";

const DAY = 86_400;
const HOUR = 3_600;

export type ChallengeAction =
  | "publish"
  | "finish"
  | "object"
  | "vote"
  | "resolve"
  | "release-bond";

/** The three steps a milestone goes through, for the strip on each card. */
export const CHALLENGE_STEPS = [
  "Published",
  "Open to objections",
  "Unlocked",
] as const;

export const CHALLENGE_STAGE_LABEL: Record<ChallengeStage, string> = {
  "not-submitted": "Not published",
  rejected: "Turned down",
  waiting: "Open to objections",
  ready: "Ready to finish",
  voting: "Holders are voting",
  "vote-ended": "Vote ended",
  unlocked: "Unlocked",
  "unlocked-open": "Unlocked",
  "late-voting": "Holders are voting",
  "late-vote-ended": "Vote ended",
};

/** A length of time in the words people use: "7 days", "1 day", "5 hours", "less than 2 hours". */
export function span(seconds: number): string {
  if (seconds >= 2 * DAY || seconds === DAY) {
    const days = Math.round(seconds / DAY);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (seconds >= 2 * HOUR) return `${Math.round(seconds / HOUR)} hours`;
  return "less than 2 hours";
}

/** A calendar date, for something that happened. */
const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** An exact moment with its time zone, for a deadline someone may have to act before. */
export const deadline = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

/** How many of {@link CHALLENGE_STEPS} are behind a milestone in this stage. */
export function challengeDone(stage: ChallengeStage): number {
  switch (stage) {
    case "not-submitted":
    case "rejected":
      return 0;
    case "waiting":
    case "ready":
    case "voting":
    case "vote-ended":
      return 1;
    default:
      return 3;
  }
}

/** The connected person, as far as this milestone is concerned. */
export interface ChallengeViewer {
  /** Null when no wallet is connected. */
  wallet: string | null;
  onTeam: boolean;
  /** What their vote would count for (zero for the team, and for anyone with nothing to vote with). */
  weight: bigint;
  /** They have already voted on the open objection (the objector has). */
  voted: boolean;
}

export const NO_VIEWER: ChallengeViewer = {
  wallet: null,
  onTeam: false,
  weight: 0n,
  voted: false,
};

/** What the lock needs to be true before a milestone can be published, as far as the chain says. */
export interface ChallengeGate {
  /** The chain's latest block: a milestone cannot be published before the lock's earliest block. */
  block: number;
  /** The milestone before this one has stood (the first has nothing before it): milestones go in order. */
  previousStood: boolean;
}

/** Why publishing is not open yet, in words, or null when it is. */
export function challengePublishBlock(
  index: number,
  terms: ChallengeTerms,
  gate: ChallengeGate,
): string | null {
  if (gate.block < terms.earliestBlock) {
    return `Publishing opens when the buyers can claim, at block ${terms.earliestBlock}. The chain is at block ${gate.block}.`;
  }
  if (!gate.previousStood) {
    return `Milestones go in order: milestone ${index} has to unlock first.`;
  }
  return null;
}

/** What the connected person can do about this milestone right now. */
export function challengeActions(
  m: ChallengeMilestone,
  terms: ChallengeTerms,
  now: number,
  who: ChallengeViewer,
  gate: ChallengeGate,
): ChallengeAction[] {
  const actions: ChallengeAction[] = [];
  const connected = who.wallet !== null;
  switch (m.stage) {
    case "not-submitted":
    case "rejected":
      if (
        connected &&
        who.onTeam &&
        challengePublishBlock(m.index, terms, gate) === null
      ) {
        actions.push("publish");
      }
      break;
    case "ready":
      if (connected) actions.push("finish");
      break;
    case "waiting":
    case "unlocked-open":
      if (connected && !who.onTeam && who.weight > 0n) actions.push("object");
      break;
    case "voting":
    case "late-voting":
      if (connected && !who.onTeam && who.weight > 0n && !who.voted) {
        actions.push("vote");
      }
      break;
    case "vote-ended":
    case "late-vote-ended":
      if (connected) actions.push("resolve");
      break;
    case "unlocked":
      break;
  }
  // The bond comes back to whoever posted it once the month is over and nothing is open against it.
  if (
    connected &&
    m.phase === "stood" &&
    m.bond > 0n &&
    !m.objection?.open &&
    now >= m.unlockedAt + terms.clawback
  ) {
    actions.push("release-bond");
  }
  return actions;
}

/** The sentence under a milestone's name: where it stands and what happens next. */
export function challengeHeadline(
  m: ChallengeMilestone,
  terms: ChallengeTerms,
  now: number,
): string {
  const open = m.objection?.open ? m.objection : null;
  switch (m.stage) {
    case "not-submitted":
      return `Not published yet. When the team publishes its evidence, holders have ${span(m.nextWindow)} to object. If nobody does, it unlocks.`;
    case "rejected":
      return `Holders turned down the last attempt. The team can publish again, and holders then have ${span(m.nextWindow)} to object.`;
    case "waiting":
      return `Published. Holders can object until ${deadline(m.windowEnds)}. If nobody does, it unlocks.`;
    case "ready":
      return "Nobody objected. Anyone can finish it now, and the tokens unlock.";
    case "voting":
      return open
        ? `A holder objected. Holders vote until ${deadline(open.voteEnds)}.`
        : "A holder objected.";
    case "vote-ended":
      return "The vote has ended. Anyone can settle it.";
    case "unlocked-open":
      return `Unlocked on ${date(m.unlockedAt)}. For ${span(m.unlockedAt + terms.clawback - now)} more a holder can raise one more objection; if holders uphold it, the team's remaining locked tokens are burned.`;
    case "unlocked":
      return `Unlocked on ${date(m.unlockedAt)}.`;
    case "late-voting":
      return open
        ? `Unlocked on ${date(m.unlockedAt)}, and a holder has objected to it since. Holders vote until ${deadline(open.voteEnds)}. If it is upheld, the team's remaining locked tokens are burned.`
        : `Unlocked on ${date(m.unlockedAt)}, and a holder has objected to it since.`;
    case "late-vote-ended":
      return `The vote on the objection to this unlocked milestone has ended. Anyone can settle it.`;
  }
}
