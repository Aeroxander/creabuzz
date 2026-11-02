/**
 * The one next action of a project's funding agreement, from the read the
 * lock already answers (`useChallengeLock`).
 *
 * The project's overview shows the agreement — what the team's Shares unlock
 * against. How each milestone is judged is read from the chain, and this
 * module picks the finest one next step that read implies, with whose turn it
 * is: the team publishes, holders object and vote, anyone settles or finishes.
 * It invents nothing: a lock that could not be read yields no next action, and
 * a page that cannot say whose turn it is stays quiet rather than guessing.
 *
 * Pure and alias-free: `agreement-next.test.mjs` drives it under `node --test`.
 */

import type {
  ChallengeLockView,
  ChallengeMilestone,
} from "@creaton/core/launchpad/milestoneChallenge.ts";
import { CHALLENGE_STAGE_LABEL } from "./challenge-copy.ts";

/** The one next action the agreement implies, or null when nothing is open. */
export interface AgreementNext {
  /** The milestone it is about (0-based). */
  index: number;
  /** One sentence: where it stands (the lock's own headline). */
  state: string;
  /** Whose turn it is on it. */
  role: string;
  /** Unix seconds when this changes by itself, when there is such a moment. */
  due: number | null;
}

/**
 * Whose turn a stage's step is, for a reader with no wallet connected — this
 * surface speaks about the project, not about "you".
 */
function roleForStage(m: ChallengeMilestone): string {
  switch (m.stage) {
    case "not-submitted":
    case "rejected":
      return "the team";
    case "waiting":
    case "unlocked-open":
      return "holders who can object";
    case "ready":
      return "anyone";
    case "voting":
    case "late-voting":
      return "holders (the team's Shares do not vote)";
    case "vote-ended":
    case "late-vote-ended":
      return "anyone";
    case "unlocked":
      return "no one — it is done";
  }
}

/** When the state changes by itself, or null. */
function dueForStage(m: ChallengeMilestone): number | null {
  const open = m.objection?.open ? m.objection : null;
  switch (m.stage) {
    case "waiting":
      return m.windowEnds > 0 ? m.windowEnds : null;
    case "ready":
    case "not-submitted":
    case "rejected":
    case "vote-ended":
    case "late-vote-ended":
      return null;
    case "voting":
    case "late-voting":
      return open !== null ? open.voteEnds : null;
    case "unlocked-open":
      return m.unlockedAt > 0 ? m.unlockedAt : null;
    case "unlocked":
      return null;
  }
}

/** Order matters: it is "the one next action", so the most-definite turn first. */
const STAGE_ORDER: readonly ChallengeMilestone["stage"][] = [
  "voting",
  "late-voting",
  "vote-ended",
  "late-vote-ended",
  "ready",
  "waiting",
  "unlocked-open",
  "not-submitted",
  "rejected",
  "unlocked",
];

/**
 * The one next action the agreement has open right now, or null when every
 * milestone has stood through its windows and nothing is waiting on anyone.
 * The state words are the shared stage label (`challenge-copy.ts`), so this
 * page and the Milestones tab never disagree about what a milestone is in.
 */
export function agreementNextAction(
  view: ChallengeLockView,
): AgreementNext | null {
  const open = view.milestones
    .map((m, index) => ({
      m,
      index,
      role: roleForStage(m),
      due: dueForStage(m),
    }))
    .filter(({ m }) => m.stage !== "unlocked")
    .sort(
      (a, b) =>
        STAGE_ORDER.indexOf(a.m.stage) - STAGE_ORDER.indexOf(b.m.stage) ||
        a.index - b.index,
    );
  const first = open[0];
  if (!first) return null;
  return {
    index: first.index,
    state: CHALLENGE_STAGE_LABEL[first.m.stage],
    role: first.role,
    due: first.due,
  };
}
