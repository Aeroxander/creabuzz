/**
 * The court's words (N7): where a case stands, what a ruling means for the work, and a juror's stake. Pure, so
 * `court-copy.test.mjs` pins it.
 */

import { type CourtCase, MAX_ROUNDS, periodEnds } from "./court.ts";
import { formatUnits } from "./dao-actions.ts";

/** What a ruling means for the work the case is about. */
export function rulingWords(ruling: number): string {
  return ruling === 1
    ? "for the work"
    : ruling === 2
      ? "against the work"
      : "neither way";
}

/** Where a case stands, in one sentence. */
export function caseStatusLine(
  c: Pick<CourtCase, "period" | "periodStart" | "rounds" | "ruling">,
  date: (seconds: number) => string,
): string {
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
        ? `The panel ruled ${rulingWords(c.ruling)}. Anyone can appeal to a larger panel until ${date(ends)}.`
        : `The last panel ruled ${rulingWords(c.ruling)}. It can be settled now.`;
    case "ruled":
      return c.ruling === 0
        ? "Final: no ruling, so the bounty stays as it was."
        : `Final ruling: ${rulingWords(c.ruling)}.`;
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
      ? `Stake at least ${seat} CREATE: one seat.`
      : null;
  }
  const left = staked - amount;
  return left > 0n && left < seatStake
    ? `Take out all of it, or leave at least ${seat} CREATE: one seat.`
    : null;
}

/** A juror's stake in a line. */
export function stakeLine(
  staked: bigint,
  locked: bigint,
  seatStake: bigint,
): string {
  if (staked === 0n) return "You have nothing staked.";
  const seats = seatStake === 0n ? 0n : staked / seatStake;
  const free = seatStake === 0n ? 0n : (staked - locked) / seatStake;
  return `You stake ${formatUnits(staked, 18)} CREATE: ${seats} ${seats === 1n ? "seat" : "seats"}, ${free} free.`;
}

/** What the court owes a juror, naming only what is owed. */
export function owedLine(fee: bigint, stake: bigint): string {
  const parts = [
    fee > 0n ? `${formatUnits(fee, 6)} USDC` : null,
    stake > 0n ? `${formatUnits(stake, 18)} CREATE` : null,
  ].filter((p) => p !== null);
  return `The court owes you ${parts.join(" and ")}.`;
}
