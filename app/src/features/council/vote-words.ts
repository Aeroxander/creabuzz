/**
 * Every sentence of the vote card (`docs/next-version/COUNCIL-PLAN.md` section 6.2), as pure functions of the numbers they
 * speak of: the card, the stand sheet and the Council's lines say the same thing, and one test walks them all. **No number
 * is typed here**: the seats, the lists, the day, the vote's length, the wait and the turnout floor all come from the
 * parsed `vote.rule` and `council.needed`, so a test that changes the rule changes the sentence.
 *
 * Rules the words keep: "a list of five accounts", never "five people" (an account can be anyone); the words protect, safe,
 * secure, guarantee, independent and decentralised are never used, and no sentence says or implies that a vote protects
 * money: they say taking out stays open. Two sentences come from their existing constants and are never retyped: the
 * public line (`PUBLIC_LINE`, where a person votes or stands) and the take-out banner (`TAKE_OUT_BANNER`, carried by any
 * sheet that speaks of taking money out). Protocol words, event names, kind numbers and error names are never shown.
 */
import type {
  CouncilNumbers,
  RunnerKind,
  VoteOpenNumbers,
  VoteOptionNumbers,
  VoteRule,
} from "../money/numbers-types";
import { timeText } from "../money/numbers";

/** Shown word for word where a person votes or stands: the constant the room already shows. */
export { PUBLIC_LINE } from "../room/room-words";
/** Shown by any sheet that speaks of taking money out: the constant the shell's banner already shows. */
export { TAKE_OUT_BANNER } from "../pot/pot-words";

/** The words no sentence here may use (COUNCIL-PLAN.md section 6). A test walks every sentence for them. */
export const FORBIDDEN_WORDS = [
  "protect",
  "safe",
  "secure",
  "guarantee",
  "independent",
  "decentralised",
  "five people",
] as const;

const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/** A count in words: "two", "five"; a number past the words it knows is said as a figure, which still comes from the rule. */
export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function capped(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A span of time in the contract's own days: `standSecs` is one day (the plan fixes it), so "one day", "three days",
 * "16.5 days". Never the real-world words "24 hours": a test network's day is 240 seconds.
 */
function spanWords(seconds: number, daySecs: number): string {
  const days = daySecs > 0 ? seconds / daySecs : 0;
  if (days === 1) return "one day";
  const shown = Number.isInteger(days) ? countWord(days) : days.toFixed(1);
  return `${shown} days`;
}

/** A part of a whole as a percent, rounded down: "33%". Zero for an empty whole. */
function percentDown(part: bigint, whole: bigint): bigint {
  return whole === 0n ? 0n : (part * 100n) / whole;
}

/** The turnout floor as a percent of the snapshot, rounded down, straight from the rule's divisor. */
export function floorPercent(rule: VoteRule): bigint {
  return BigInt(rule.floorDivisor) === 0n
    ? 0n
    : 100n / BigInt(rule.floorDivisor);
}

/** How many seats come up, from the Council (two), or nothing when the record has no Council to say. */
function seatsUp(council: CouncilNumbers | null): number {
  return council ? council.upSeats.length : 0;
}

// --- The card's head ------------------------------------------------------------------------------------------------------

/** The card's title: by kind, and the two seats come up (a number the Council says, not one typed here). */
export function voteTitle(input: {
  vote: VoteOpenNumbers;
  council: CouncilNumbers | null;
}): string {
  if (input.vote.kind === "replace") return "A vote on who runs this project";
  const up = seatsUp(input.council);
  if (up === 0) return "Seats on the Council are up";
  return up === 1
    ? "One seat on the Council is up"
    : `${capped(countWord(up))} seats on the Council are up`;
}

/** What a replace vote is choosing between: "a new Council of {seats} accounts". */
export function replaceIntro(rule: VoteRule): string {
  return `Holders are choosing between keeping things as they are and a new Council of ${countWord(rule.seats)} accounts.`;
}

/** The first day: names may be put forward, and the number of lists is the rule's own. */
export function standingLine(input: {
  vote: VoteOpenNumbers;
  rule: VoteRule;
  council: CouncilNumbers | null;
}): string {
  const until = timeText(input.vote.standEnd);
  if (input.vote.kind === "replace")
    return `Anyone with parked Shares can put forward a list of ${countWord(input.rule.seats)} accounts until ${until}. Voting starts then.`;
  const up = seatsUp(input.council);
  const which =
    up === 1
      ? "One of the seats is being voted on."
      : `${capped(countWord(up))} of the ${countWord(input.rule.seats)} seats are being voted on.`;
  return `${which} Anyone with parked Shares can stand until ${until}.`;
}

/** While the vote runs. */
export function votingLine(vote: VoteOpenNumbers): string {
  return `Voting ends ${timeText(vote.voteEnd)}.`;
}

/**
 * The one count line: what part of all Shares has voted, the floor the rule sets, and how a choice wins. A figure under
 * the floor never reads as the floor ("less than 33%", never "33%").
 */
export function countLine(vote: VoteOpenNumbers, rule: VoteRule): string {
  const floor = floorPercent(rule);
  const cast = percentDown(vote.cast, vote.supply);
  const voted =
    vote.cast < vote.floor && cast >= floor ? `Less than ${floor}` : `${cast}`;
  const wins =
    vote.kind === "replace"
      ? "a list wins with more than half of the votes cast"
      : "a person wins when more Shares are for them than for keeping the seat as it is";
  return `${voted}% of Shares have voted. The vote counts when at least ${floor}% do, and ${wins}.`;
}

/** How a seat election ends when nobody wins it: the two seats' own rule. */
export function seatsStayLine(): string {
  return "Seats stay as they are if too few Shares vote, or if no one gets more Shares than keeping each seat as it is.";
}

/** The stale sentence of section 6.6: said instead of a state line, never alongside it. */
export function staleLine(): string {
  return "These numbers are older than the server promises, so nothing is said here about where the vote stands now.";
}

// --- The rows -------------------------------------------------------------------------------------------------------------

/** Option 0's row: the two seats, or things as they are. */
export function keepRowWords(
  kind: VoteOpenNumbers["kind"],
  council: CouncilNumbers | null,
): string {
  if (kind === "replace") return "Keep things as they are";
  const up = seatsUp(council);
  if (up === 0) return "Keep the seats as they are";
  return up === 1
    ? "Keep the seat as it is"
    : `Keep the ${countWord(up)} seats as they are`;
}

/** A row's words: "List {n}: {account, ...}", one account, or "keep". */
export function optionWords(input: {
  option: VoteOptionNumbers;
  kind: VoteOpenNumbers["kind"];
  council: CouncilNumbers | null;
  nameOf: (address: string) => string;
}): string {
  const { option } = input;
  if (option.kind === "keep") return keepRowWords(input.kind, input.council);
  if (option.kind === "person") return input.nameOf(option.members[0] ?? "");
  return `List ${option.index}: ${option.members.map(input.nameOf).join(", ")}`;
}

/** "{x}%" of the Shares cast, rounded down (the row's own figure, never colour alone). */
export function optionPercent(
  vote: VoteOpenNumbers,
  option: VoteOptionNumbers,
): string {
  return `${percentDown(option.tally, vote.cast)}%`;
}

/** A list's proposer, said plainly: nobody on the list had to agree to it. */
export function proposerLine(
  option: VoteOptionNumbers,
  nameOf: (address: string) => string,
): string {
  return option.proposer === null || option.kind !== "list"
    ? ""
    : `Put forward by ${nameOf(option.proposer)}. Nobody on a list has to agree to it.`;
}

/** A voter's own choice is marked in words, never by colour alone. */
export const YOUR_VOTE = "Your vote";

/** The press on one row: one distinct name per row (a screen reader hears which). */
export function votePressName(input: {
  option: VoteOptionNumbers;
  kind: VoteOpenNumbers["kind"];
  council: CouncilNumbers | null;
  nameOf: (address: string) => string;
}): string {
  const words = optionWords(input);
  if (input.option.kind === "keep")
    return input.kind === "replace"
      ? "Vote to keep things as they are"
      : "Vote to keep the seats as they are";
  if (input.option.kind === "list") return `Vote for ${words}`;
  return `Vote for ${words}`;
}

/** The presses that open a name or a list; no number is typed. */
export function standPressWords(kind: VoteOpenNumbers["kind"]): string {
  return kind === "replace" ? "Put forward a list" : "Stand for a seat";
}

// --- Under the card, and after the vote -----------------------------------------------------------------------------------

/** A visitor (not signed in, or holding nothing here) reads the card and presses nothing. */
export function onlyBackersLine(): string {
  return "Only people who back this project can vote.";
}

/** A holder whose Shares were not parked before the vote opened: no vote press, and taking out stays open. */
export const CANNOT_VOTE =
  "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time.";

const FROM_RUNNER: Record<RunnerKind, string> = {
  single: "the founder",
  pair: "the two-person team",
  council: "the Council",
};

/**
 * The planned change, shown from `voteEnd` on whether or not anyone has recorded it: who takes over, and when, in the
 * same weight as a planned task. The five accounts are the winning list's, in its own order.
 */
export function plannedChangeLine(input: {
  vote: VoteOpenNumbers;
  nameOf: (address: string) => string;
  runnerKind: RunnerKind | null;
}): string {
  const won = input.vote.result;
  const winners = won?.winners ?? [];
  const taken = input.vote.options.find((o) => o.index === winners[0]);
  const list = (taken?.members ?? []).map(input.nameOf).join(", ");
  return `Holders voted to change who runs this project. On ${timeText(input.vote.effectiveAt)} ${list} take over from ${FROM_RUNNER[input.runnerKind ?? "single"]}. You can take your money out before then. Taking out stays open.`;
}

/** A seat election's result: who takes their seats, and when; or that the seats stay as they are. */
export function seatsResultLine(input: {
  vote: VoteOpenNumbers;
  nameOf: (address: string) => string;
}): string {
  const winners = input.vote.result?.winners ?? [];
  const seats = winners
    .map((index) => input.vote.options.find((o) => o.index === index))
    .filter((option): option is VoteOptionNumbers => Boolean(option))
    .map((option) => input.nameOf(option.members[0] ?? ""));
  if (seats.length === 0) return "The vote ended. The seats stay as they are.";
  const who =
    seats.length === 1
      ? (seats[0] as string)
      : `${seats.slice(0, -1).join(", ")} and ${seats[seats.length - 1]}`;
  return `The vote ended. ${who} take their seats on ${timeText(input.vote.effectiveAt)}. You can take your money out before then.`;
}

/** A candidate's short text, shown whole; when its signed record is not the one the chain stored, the row says "No text". */
export const NO_TEXT = "No text";
/** Shown while a candidate's own words are being looked for: "No text" waits for the read to finish. */
export const TEXT_LOOKING = "Looking for the words they signed…";
/** Shown when their words could not be read right now: what happened, and what to do next. */
export const TEXT_FAILED =
  "Their words could not be read right now. Reload the page in a moment to look again.";

export function candidacyText(
  recordHash: string | null,
  signed: { id: string; text: string } | null,
): string {
  if (
    !recordHash ||
    !signed ||
    signed.id.toLowerCase() !== recordHash.toLowerCase()
  )
    return NO_TEXT;
  return signed.text;
}

/** A result that changes nothing, shown for three days and then gone. */
export function endedLine(): string {
  return "The vote ended. Nothing changes.";
}

/** The last line of a replace card: a vote changes who runs the project, and taking out stays open. */
export function lastLine(): string {
  return "A vote only changes who runs this project. Taking out stays open: if you will be away, you can take your money out first.";
}

/**
 * The stand sheet's opening mode: what pressing "Open the vote" starts, in the rule's own numbers (the day, the vote's
 * length, the wait), and what parked Shares also count toward.
 */
export function openVoteSentence(rule: VoteRule): string {
  const day = rule.standSecs;
  return `This opens a vote. For the first ${spanWords(day, day)} anyone with parked Shares can put forward a list. Then holders vote for ${spanWords(rule.voteSecs, day)}. Nothing changes for ${spanWords(rule.waitSecs, day)} after that, so anyone can take their money out first. Parked Shares also count toward pausing the project's spending.`;
}

/** What the card says while a result waits, and who still runs the project (section 6.1). */
export function plannedTaskWeightLine(effectiveAt: number): string {
  return `Holders voted to change who runs this project on ${timeText(effectiveAt)}. Until then you still run it.`;
}

/** The opener's line (section 6.3): shown only when the parked Shares already meet the rule's floor. */
export function openerLine(): string {
  return "Enough Shares are parked to ask holders who should run this project.";
}
