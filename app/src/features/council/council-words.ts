/**
 * Every sentence of the Council part of the app: the refusals the vote and Council presses can meet, the Council section
 * of the Team tab (`docs/next-version/COUNCIL-PLAN.md` section 6.4) and the hand-over sheet (6.5). Pure: a function of the
 * parsed record and of the network's own refusal, never of a name, a code or a hex string.
 *
 * **Keyed by what the network refused, not by the refusal's name.** `refusalOf` reads the contract's own error out of a
 * failed step and says which of these happened; the screens show `refusalWords`, so no contract name or error name can
 * reach a person. Each sentence says what happened and what to do next. The numbers in them (how many seats must agree,
 * how long the wait, how long the cooldown, the floor) come from the parsed `vote.rule` and `council.needed`, never typed.
 *
 * A Council is always "five accounts", never "five people": an account can be anyone, or one person with several.
 */
import type {
  CouncilNumbers,
  CouncilSeatNumbers,
  VoteRule,
} from "../money/numbers-types";
import { dayText, timeText } from "../money/numbers";
import { potRefusalOf } from "../money/pot-copy";
import { countWord } from "./vote-words";

/** Shown word for word where a person votes, stands or agrees: the constant the room already shows. */
export { PUBLIC_LINE } from "../room/room-words";

/** The words no sentence here may use (COUNCIL-PLAN.md section 6). A test walks every sentence for them. */
export { FORBIDDEN_WORDS } from "./vote-words";

/** What the person was doing when a vote or Council step stopped. */
export type CouncilPress =
  | "vote"
  | "stand"
  | "stand-list"
  | "open-replace"
  | "open-seats"
  | "propose"
  | "agree"
  | "withdraw"
  | "hand-over";

/** What the network refused, in the app's own words: the copy module's key, never a contract's. */
export type CouncilRefusal =
  /** The person's Shares were not parked when the ballot opened. */
  | "not-eligible-vote"
  /** Not enough Shares parked to open a replace vote. */
  | "not-eligible-open"
  /** Not enough Shares parked from before the ballot opened to stand. */
  | "not-eligible-stand"
  /** The vote ended while the press was open. */
  | "vote-ended"
  /** Voting has not started: the names are still being put forward. */
  | "voting-not-started"
  /** The names are final: standing is closed. */
  | "standing-closed"
  /** Standing twice in one ballot. */
  | "already-stood"
  /** A list needs five different accounts. */
  | "bad-members"
  /** A list names an account of the project itself. */
  | "project-account"
  /** That account already holds a seat. */
  | "holds-seat"
  /** Every place is taken by a larger stake. */
  | "no-room"
  /** A vote is already open. */
  | "vote-open"
  /** A vote cannot open yet: the cooldown after a "kept" result. */
  | "cooldown"
  /** The seats are not up for a vote yet. */
  | "seats-not-due"
  /** The same call is proposed twice, or the agreement is already given. */
  | "already-agreed"
  /** The proposal ran out, or the seats changed under it. */
  | "ran-out"
  /** The Council offered the seat and nobody took it in time. */
  | "offer-ran-out"
  /** The Council is not switched on for this network. */
  | "no-council"
  /** The project has wound down. */
  | "wound-down"
  /** The server marks this account as a helper: a person has to stand. */
  | "helper-account"
  /** None of the above: nothing is claimed about why. */
  | "other";

/** What the screens know when a refusal is shown: the record's own numbers, and the names already resolved. */
export interface RefusalContext {
  /** Every number a sentence needs; absent when the record's vote rule did not read. */
  rule?: VoteRule | null;
  /** The Council's seats and threshold, when the record read them. */
  council?: CouncilNumbers | null;
  /** A name for an account, as the screens already show accounts (a linked name, else a short address). */
  nameOf?: (address: string) => string;
  /** The ballot's phase, when the app can tell it: it separates "voting has not started" from "the vote ended". */
  phase?: string | null;
  /** The account a refusal names, when the app knows it (a seat already held). */
  account?: string | null;
}

/** The contract error name that is a person's action, mapped to what the app says happened. */
const REFUSALS: Record<string, readonly [CouncilPress[], CouncilRefusal]> = {
  NotEligible: [["open-replace"], "not-eligible-open"],
  VotingClosed: [["open-replace", "open-seats"], "vote-ended"],
  TooEarly: [["open-seats"], "seats-not-due"],
  Cooldown: [[], "cooldown"],
  BallotLive: [[], "vote-open"],
  AlreadyStood: [[], "already-stood"],
  StandingClosed: [[], "standing-closed"],
  BadMembers: [[], "bad-members"],
  ProjectAccount: [[], "project-account"],
  HoldsSeat: [[], "holds-seat"],
  AlreadySeated: [[], "holds-seat"],
  NoRoom: [[], "no-room"],
  AlreadyAgreed: [[], "already-agreed"],
  Expired: [["hand-over"], "offer-ran-out"],
  SeatsChanged: [[], "ran-out"],
  NoCouncil: [[], "no-council"],
  WoundDown: [[], "wound-down"],
};

/**
 * What the network refused in a failed step, or null when the error is not one of these (the screens then fall back to
 * the money copy's own sentence). The action separates a refusal that one error name covers: `NotEligible` is "not
 * parked for this ballot" to vote, "not enough parked" to open one and "not enough parked to stand" to stand.
 */
export function refusalOf(
  error: unknown,
  press: CouncilPress,
  phase?: string | null,
): CouncilRefusal | null {
  const found = potRefusalOf(error);
  if (!found) return null;
  const entry = REFUSALS[found.name];
  if (entry) {
    const [presses, refusal] = entry;
    // A refusal that reads the same for every press says so; the ones a name covers for several presses are split below.
    if (presses.length === 0 || presses.includes(press)) return refusal;
  }
  // The names whose sentence depends on the press.
  if (found.name === "NotEligible") {
    if (press === "vote") return "not-eligible-vote";
    if (press === "stand" || press === "stand-list")
      return "not-eligible-stand";
    return "not-eligible-open";
  }
  if (found.name === "Expired")
    return press === "hand-over" ? "offer-ran-out" : "ran-out";
  if (found.name === "VotingClosed") {
    if (press !== "vote") return "standing-closed";
    // The contract answers the same error before the names are final and after the vote ends; the phase tells them apart.
    return phase === "standing" ? "voting-not-started" : "vote-ended";
  }
  return "other";
}

/** "@name" from an account the record names; the account itself when there is no name to resolve. */
function who(context: RefusalContext, address: string | null): string {
  if (address === null) return "That account";
  return context.nameOf ? context.nameOf(address) : address;
}

/** The days a span of the rule's own days comes to, for the cooldown's sentence: "4". */
function daysIn(seconds: number, daySecs: number): number {
  return daySecs > 0 ? Math.round(seconds / daySecs) : 0;
}

/**
 * The sentence for a refusal, from the plan's section 6.2 table. `openedAt` is the time the app knows for the refusal
 * that names one (voting starts, a seat election is due, a cooldown ends); without it the sentence says what to do
 * without a date, never a guessed one.
 */
export function refusalWords(
  refusal: CouncilRefusal,
  context: RefusalContext = {},
  at: number | null = null,
): string {
  const rule = context.rule ?? null;
  const needed = context.council?.needed ?? rule?.needed ?? 0;
  switch (refusal) {
    case "not-eligible-vote":
      return "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time.";
    case "not-eligible-open":
      return "Not enough Shares are parked yet to open a vote. Nothing was sent.";
    case "not-eligible-stand":
      return "To stand you need Shares parked from before the vote opened. Nothing was sent.";
    case "vote-ended":
      return "This vote has ended. Nothing was sent. The result is on the project page.";
    case "voting-not-started":
      return at !== null
        ? `Voting starts at ${timeText(at)}, when the names are final. Nothing was sent.`
        : "Voting starts when the names are final. Nothing was sent.";
    case "standing-closed":
      return "Names are final now: the vote has started. Nothing was sent.";
    case "already-stood":
      return "You already put a name forward in this vote. Nothing was sent.";
    case "bad-members":
      // The count comes from the rule; without it the sentence says what to do and types no number.
      return rule !== null
        ? `A list needs ${countWord(rule.seats)} different accounts. Nothing was sent.`
        : "A list needs different accounts. Nothing was sent.";
    case "project-account":
      return "These accounts belong to the project and cannot hold a seat. Nothing was sent.";
    case "holds-seat":
      return `${who(context, context.account ?? null)} already holds a seat. Nothing was sent.`;
    case "no-room":
      return "Every place is taken by a name with more Shares parked than yours. Park more Shares and try again.";
    case "vote-open":
      return "A vote is already open. Nothing was sent. Look at the project page for when it ends.";
    case "cooldown":
      return rule !== null
        ? `A vote can't open yet: holders said no to the last one less than ${daysIn(rule.cooldownSecs, rule.standSecs)} days ago. Nothing was sent.`
        : "A vote can't open yet: holders said no to the last one recently. Nothing was sent.";
    case "seats-not-due":
      return at !== null
        ? `The seats are not up for a vote yet: the next vote can open from ${timeText(at)}. Nothing was sent.`
        : "The seats are not up for a vote yet. Nothing was sent.";
    case "already-agreed":
      return "You have already agreed to this. Nothing changed.";
    case "ran-out":
      return "This ran out or the seats changed. Propose it again if it is still needed. Nothing changed.";
    case "offer-ran-out":
      return "The offer ran out. Offer the seat again. Nothing changed.";
    case "no-council":
      return "This network does not have Councils switched on, so this cannot be done. Nothing changed.";
    case "wound-down":
      return "This project has wound down, so no vote can open. Nothing changed.";
    case "helper-account":
      return "This account is marked as a helper. A person has to stand.";
    case "other":
      return `This did not go through. Nothing changed. ${
        needed > 0 ? "Try again, or ask the other seats." : "Try again."
      }`;
  }
}

/** The fallback the screens show when a refusal is not one this module knows: it never says a name. */
export const REFUSAL_FALLBACK =
  "That did not go through. Nothing changed. Try again in a moment.";

// --- The Council section (Team tab, 6.4) ---------------------------------------------------------------------------------

export const COUNCIL_HEADING = "The Council";

/**
 * "The Council could not be read right now." (section 6.6): the section says it and presses nothing. It says what to do
 * next, like every other stopped read.
 */
export const COUNCIL_UNREADABLE =
  "The Council could not be read right now, so nothing is shown about it. Nothing changed. Reload the page in a moment to look again.";

/** "Five accounts run this project together. {needed} of them must agree to every action." */
export function councilSummary(council: CouncilNumbers): string {
  return `${capped(countWord(council.seats.length))} accounts run this project together. ${council.needed} of them must agree to every action.`;
}

/** A seat's one line: who holds it (or "Open seat"), "You" on your own, and the date it was taken. */
export function seatLine(input: {
  seat: CouncilSeatNumbers;
  index: number;
  nameOf: (address: string) => string;
  isMe: boolean;
}): string {
  const label = `Seat ${input.index + 1}`;
  if (input.seat.account === null) return `${label}: Open seat`;
  const held = input.isMe ? "You" : input.nameOf(input.seat.account);
  const since =
    input.seat.seatedAt === null
      ? ""
      : `, since ${dayText(input.seat.seatedAt)}`;
  return `${label}: ${held}${since}`;
}

/** The field labels of the five-account lists ("Seat 1" to "Seat 5"), numbered from the record's own seats. */
export function seatFieldLabel(index: number): string {
  return `Seat ${index + 1}`;
}

/** "Two seats come up for a vote on {date}." — or "now" while a vote is open; the two are the Council's own seats. */
export function nextElectionLine(input: {
  council: CouncilNumbers;
  now: number;
  voteOpen: boolean;
}): string {
  const two = countWord(input.council.upSeats.length);
  if (input.voteOpen) return `${capped(two)} seats come up for a vote now.`;
  return `${capped(two)} seats come up for a vote on ${dayText(input.council.nextElection)}.`;
}

export const WAITING_HEADING = "Waiting for your agreement";

/** "{k} of {needed} have agreed": both numbers are the record's and the events', never typed. */
export function agreedLine(k: number, needed: number): string {
  return `${k} of ${needed} have agreed`;
}

export const AGREE = "Agree";
export const GIVE_UP_SEAT = "Give up your seat";
export const TAKE_BACK_AGREEMENT = "Take back my agreement";
/** An action that ran out says what to do next. */
export const RAN_OUT = "This ran out; propose it again if it is still needed.";

/** What a seat holder's press becomes: a proposal the other seats must agree to. */
export function proposeAskLine(needed: number, seats: number): string {
  return `This asks the other seats to agree. It runs when ${needed} of ${countWord(seats)} have agreed.`;
}

/** Giving up a seat, said before the press (the contract's own `resign`): what happens and what does not. */
export function resignWords(needed: number, seats: number): string[] {
  return [
    "Your seat comes up first at the next vote, which fills it again.",
    `Every call waiting for the seats' agreement now stops. Anything still needed has to be proposed again (${needed} of ${countWord(seats)} must agree to it).`,
    "Nothing else changes: the project keeps running with the seats that are left, and taking out stays open.",
  ];
}

/** The section's last line (counsel reads it): a Council's powers, and that taking out stays open. */
export function councilLastLine(seats: number): string {
  return `A Council is ${countWord(seats)} accounts. It can do what a founder could do, with the same limits, and nothing more. Taking out stays open.`;
}

// --- The hand-over sheet (seat section, 6.5) ------------------------------------------------------------------------------

export const HAND_OVER_COUNCIL = "Hand over to a Council";

/** What the offer does, from the record's own threshold and seats. */
export function handOverIntro(needed: number, seats: number): string {
  return `Once they take the seat, any ${needed} of the ${countWord(seats)} must agree to what you could do alone. Your Team Shares are not changed. This takes two steps: you offer the seat, then anyone can make the Council.`;
}

export const OFFER_SEAT = "Offer the seat";
export const MAKE_COUNCIL = "Make the Council";

function capped(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
