/**
 * The sentences of the screens about who runs a project's money: who it is now, what running it together means, what an offer
 * of the seat is and how long it lasts, and what winding down does to backers. Pure: each is a function of the project's
 * numbers, the chain's seat and a name for an address, so one test holds every sentence.
 */
import { dayText, type ProjectNumbers, timeText } from "../money/numbers";
import { spanOf } from "../launch/launch-terms";

/** What running a project together means, in one sentence. */
export const PAIR_MEANING =
  "Running it together means both of you must agree to every step that moves money or changes a rule (a draw, a new allowance, a Team Shares grant, the door, handing over, winding down). Either of you can still check in alone.";

/** Who runs the project's money now. */
export function runsWords(
  numbers: ProjectNumbers,
  nameOf: (address: string) => string,
): string {
  if (numbers.windDown)
    return "This project has wound down. Nobody runs its money any more; what is left is for the people who hold Shares to take out.";
  const signers = numbers.runner.signers;
  if (numbers.runner.isPair && signers)
    return `${nameOf(signers[0])} and ${nameOf(signers[1])} run the project's money together. Every step that moves money needs both of them to agree.`;
  return `${nameOf(numbers.runner.address)} runs the project's money: draws the allowance, changes the rules and can hand the seat over or wind the project down.`;
}

/** How long an offer of the seat lasts and when it ends: "It lasts about 14 days, until 3 Dec 2026." */
export function offerLastsWords(lasts: number, endsAt: number): string {
  return `The offer lasts ${spanOf(lasts)}, until ${timeText(endsAt)}.`;
}

/** The same for an offer that is open: how long is left, or that it has ended. */
export function offerLeftWords(endsAt: number, now: number): string {
  return now > endsAt
    ? `The offer ended on ${timeText(endsAt)}. Nobody can take it now.`
    : `The offer ends ${timeText(endsAt)}.`;
}

/** Offering the seat to one person: what happens and what does not, before the press. */
export function handOverWords(name: string, address: string): string[] {
  return [
    `${name} (${address}) can take the seat that runs the project's money, with their own account, until the offer ends.`,
    "Until they take it you still run the project's money, and you can withdraw the offer.",
    "Once they take it you can no longer draw the allowance, change the rules, grant Team Shares or wind the project down. Helpers you set up stop working.",
  ];
}

/** What leaving the project as founder means when the seat is handed over. */
export const FOUNDER_LEAVES_WORDS =
  "I am leaving the project: when they take the seat, I give up the part of my own Team Shares I have not built up yet. What I have already built up stays mine.";

/** Asking one person to run it together: what happens, before the press. */
export function pairOfferWords(name: string, address: string): string[] {
  return [
    `${name} (${address}) can accept the second seat, with their own account, until the offer ends. Until then you still run the project's money alone.`,
    PAIR_MEANING,
  ];
}

/** What a person who is offered the seat reads. */
export function offeredToYouWords(
  from: string,
  project: string,
  founderLeaves: boolean,
): string[] {
  return [
    `${from} offered you the seat that runs ${project}'s money.`,
    "Taking it makes you the one who draws the allowance, changes the rules, grants Team Shares and can wind the project down. Helpers the earlier runner set up stop working.",
    ...(founderLeaves
      ? [
          "The founder is leaving: they give up the part of their own Team Shares they have not built up yet when you take it.",
        ]
      : []),
  ];
}

/** What a person who is asked to run it together reads. */
export function pairOfferedToYouWords(from: string, project: string): string[] {
  return [
    `${from} asked you to run ${project}'s money together.`,
    PAIR_MEANING,
    "Accepting makes the two of you a pair that runs the project from now on. It cannot be undone, but either of you can hand the seat to someone else together.",
  ];
}

/** Winding down, said before the press: what it does to backers first. */
export function windDownWords(
  mode: "runner" | "quiet",
  unit: number,
): string[] {
  const notice = spanOf(unit);
  return [
    "Taking out stays open. Everyone who holds Shares can still take their money out, with no fee and no wait, before and after.",
    "Winding down is for good. It cannot be undone.",
    "Nobody can back the project any more, and the allowance stops. What is in the allowance box goes back to the project's money.",
    mode === "runner"
      ? `Team Shares: after a notice of ${notice}, anyone can remove the Team Shares that nobody has built up yet. What each member has built up so far stays theirs.`
      : `Team Shares: after a notice of ${notice}, anyone can remove the Team Shares that have not unlocked. What has unlocked stays with its member.`,
  ];
}

/** Why anyone may wind down now. */
export function quietWindDownWhy(numbers: ProjectNumbers): string {
  return `The team has not checked in since ${dayText(numbers.clock.lastCheckIn)}, which is long enough that anyone can wind the project down.`;
}
