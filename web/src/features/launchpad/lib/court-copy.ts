/**
 * The court's words (N7): where a case stands, what a ruling means for the work, and a juror's stake. Pure, so
 * `court-copy.test.mjs` pins it.
 */

import {
  type CourtCase,
  MAX_ROUNDS,
  periodEnds,
} from "@creaton/core/launchpad/court.ts";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";

/** What kind of case it is: by the contract that asked the court. */
export type CaseKind = "bounty" | "remix" | "other";

export const caseKind = (c: Pick<CourtCase, "about">): CaseKind =>
  c.about?.kind ?? "other";

/** The question a case puts to its jurors, and what each answer is called. Choice 1 is the court's "for". */
export function caseQuestion(kind: CaseKind): {
  question: string;
  yes: string;
  no: string;
} {
  switch (kind) {
    case "bounty":
      return {
        question: "Does the work do what the bounty asked?",
        yes: "Yes, it does",
        no: "No, it doesn't",
      };
    case "remix":
      return {
        question: "Did this project break the terms it was built on?",
        yes: "Yes, it broke them",
        no: "No, it kept them",
      };
    case "other":
      return { question: "For or against?", yes: "For", no: "Against" };
  }
}

/** What a ruling means for what the case is about. */
export function rulingWords(ruling: number, kind: CaseKind = "bounty"): string {
  if (ruling !== 1 && ruling !== 2) return "neither way";
  switch (kind) {
    case "bounty":
      return ruling === 1 ? "for the work" : "against the work";
    case "remix":
      return ruling === 1
        ? "that the project broke its terms, so its bond goes to the parent"
        : "that the project kept its terms, so its bond stays";
    case "other":
      return ruling === 1 ? "for" : "against";
  }
}

/** Where a case stands, in one sentence. */
export function caseStatusLine(
  c: Pick<CourtCase, "period" | "periodStart" | "rounds" | "ruling"> & {
    kind?: CaseKind;
  },
  date: (seconds: number) => string,
): string {
  const kind = c.kind ?? "bounty";
  const ends = periodEnds(c) ?? 0;
  switch (c.period) {
    case "evidence":
      return c.rounds === 1
        ? `Collecting evidence until ${date(ends)}. Then jurors are drawn.`
        : "Appealed. The larger panel can be drawn now.";
    case "commit":
      return `Jurors seal their votes until ${date(ends)}.`;
    case "reveal":
      return `Jurors open their votes until ${date(ends)}.`;
    case "appeal":
      return c.rounds < MAX_ROUNDS
        ? `The panel ruled ${rulingWords(c.ruling, kind)}. Anyone can appeal to a larger panel until ${date(ends)}.`
        : `The last panel ruled ${rulingWords(c.ruling, kind)}. It can be settled now.`;
    case "ruled":
      return c.ruling === 0
        ? kind === "remix"
          ? "Final: no ruling, so the bond stays."
          : kind === "bounty"
            ? "Final: no ruling, so the bounty stays as it was."
            : "Final: no ruling."
        : `Final ruling: ${rulingWords(c.ruling, kind)}.`;
  }
}

/** What ending a case nobody could be drawn for does: a first round ends with no ruling; an appeal leaves the ruling it
 * appealed. */
export function timeoutLabel(rounds: number): string {
  return rounds === 1
    ? "End it with no ruling"
    : "End it: the last ruling stands";
}

/**
 * Why the court would refuse a stake or a take-out over whole seats, or null: a juror's first stake is at least one seat,
 * and taking out leaves nothing or at least one seat.
 */
export function seatProblem(
  kind: "stake" | "unstake",
  staked: bigint,
  amount: bigint,
  seatStake: bigint,
): string | null {
  const seat = formatUnits(seatStake, 18);
  if (kind === "stake") {
    return staked === 0n && amount < seatStake
      ? `Put down at least ${seat} CREATE: one seat, the smallest deposit a juror can hold.`
      : null;
  }
  const left = staked - amount;
  return left > 0n && left < seatStake
    ? `Take out all of it, or leave at least ${seat} CREATE: one seat, the smallest deposit a juror can hold.`
    : null;
}

/** A juror's deposit in a line. */
export function stakeLine(
  staked: bigint,
  locked: bigint,
  seatStake: bigint,
): string {
  if (staked === 0n) return "You have no deposit in the court.";
  const seats = seatStake === 0n ? 0n : staked / seatStake;
  const free = seatStake === 0n ? 0n : (staked - locked) / seatStake;
  return `Your deposit is ${formatUnits(staked, 18)} CREATE: ${seats} ${seats === 1n ? "seat" : "seats"}, ${free} free.`;
}

/** What the court owes a juror, naming only what is owed. */
export function owedLine(fee: bigint, stake: bigint): string {
  const parts = [
    fee > 0n ? `${formatUnits(fee, 6)} USDC` : null,
    stake > 0n ? `${formatUnits(stake, 18)} CREATE` : null,
  ].filter((p) => p !== null);
  return `The court owes you ${parts.join(" and ")}.`;
}
