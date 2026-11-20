/**
 * The sentences of the news about a person's projects (plan section 6.4). Pure. Each is one plain text node: the task's own
 * words are cut at 80 characters and are never markup, and a record the server has not refreshed says how old it is.
 * Nothing here names an event, a code or a contract; the list carries the play-money line once, at its top.
 */
import { dayText, timeText } from "../money/numbers";
import { dollarsPhrase, quotedWhat, WORDS_MAX } from "../tasks/chain/words";

/** A project's name inside a sentence: plain text, whitespace made plain, control and direction marks removed, cut. */
export function plainName(name: string | null | undefined): string {
  const plain = (name ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain === "") return "A project";
  return plain.length > WORDS_MAX ? `${plain.slice(0, WORDS_MAX - 1)}…` : plain;
}

/** How old the record an alert comes from is: nothing to say, "as of {time}", or older than a day. */
export type AlertAge = "fresh" | "as-of" | "old";

/** What a sentence adds when its record is not fresh. */
export function ageSuffix(age: AlertAge, asOf: number): string {
  if (age === "as-of") return ` (as of ${timeText(asOf)})`;
  if (age === "old") return ` (as of ${dayText(asOf)}, may be out of date)`;
  return "";
}

/**
 * The team plans to pay: before the take date, "from {date}"; once it can be taken, until when. Before the take date the row's
 * next line (`urgentWords`) says the money can leave before then, so this sentence does not say it a second time.
 */
export function plannedWords(input: {
  max: bigint;
  what: string | null;
  /** The first second it can be taken; null once it can be taken now. */
  from: number | null;
  /** The end of the take window. */
  until: number;
}): string {
  const head = `the team plans to pay up to ${dollarsPhrase(input.max)} for ${quotedWhat(input.what)}`;
  return input.from !== null
    ? `${head}, from ${timeText(input.from)}.`
    : `${head}. It can be taken until ${timeText(input.until)}. You can take your money out any time.`;
}

/** Somebody took it: the money set aside and until when. */
export function takenWords(input: {
  what: string | null;
  setAside: bigint;
  deadline: number;
}): string {
  return `${quotedWhat(input.what)} was taken. ${dollarsPhrase(input.setAside)} ${input.setAside === 1_000_000n ? "is" : "are"} set aside until ${timeText(input.deadline)}.`;
}

/** A taken task whose deadline passed and nobody has settled yet. */
export function ranOutWords(what: string | null): string {
  return `${quotedWhat(what)} ran out. The money goes back to the project.`;
}

/** A task that ended and moved money: paid, paid in part, or sent back or run out with nothing paid. */
export function endedWords(input: {
  what: string | null;
  paid: boolean;
  pay: bigint;
  setAside: bigint;
}): string {
  const what = quotedWhat(input.what);
  if (!input.paid)
    return `${what} ended and nothing was paid. The money went back to the project.`;
  return input.pay < input.setAside
    ? `${what} was paid ${dollarsPhrase(input.pay)} of the ${dollarsPhrase(input.setAside)} set aside; the rest went back.`
    : `${what} was paid ${dollarsPhrase(input.pay)}.`;
}

/** A leaver's claim on a task that ended after they took out. */
export function claimWords(input: {
  what: string | null;
  claimable: bigint;
}): string {
  return `you can claim ${dollarsPhrase(input.claimable)} from ${quotedWhat(input.what)}. It ended after you took out.`;
}

/** The sentence with its project in front: "Lantern: the team plans ...". */
export function withProject(project: string, said: string): string {
  return `${project}: ${said}`;
}

// --- The list on You ---------------------------------------------------------------------------------------------

export const NEWS_HEADING = "News about your projects";
export const NEWS_NONE = "No news about your projects.";
export const NEWS_FAILED =
  "News could not be read just now. Your money is not affected.";
export const NEWS_RETRY = "Try again";
export const NEWS_STALE =
  "Some projects' news could not be refreshed. Your money is not affected.";
export const NEWS_LOADING = "Reading the news about your projects…";

/** The take-out line under news that is time-limited: the money can leave before it moves. */
export function urgentWords(before: number): string {
  return `You can take your money out before ${timeText(before)}.`;
}

/** The button of an urgent row. */
export const NEWS_TAKE_OUT = "Take out";

/** Said plainly when more projects were found than the news is read for. */
export function newsLimitWords(limit: number): string {
  return `News is read for up to ${limit} projects you may hold. For the others, open the project: its page shows what is planned.`;
}

/** "and 2 more ended" under a project's three newest ended tasks. */
export function moreEndedWords(project: string, count: number): string {
  return `${project}: and ${count} more ended`;
}

/** Under a list that was cut: the rest is on the projects' own pages. */
export function moreNewsWords(count: number): string {
  return `And ${count} more on the projects' own pages.`;
}

/** The button that marks what is listed as read, named by how many it marks. */
export function markReadWords(count: number): string {
  return `Mark ${count} as read`;
}

/** The note on a row nobody has opened yet, spoken to a screen reader beside the sentence. */
export const NEWS_UNSEEN = "New";

/** What the section says about where news comes from and how long the notice is: nothing reaches a phone yet, so it needs the app opened. */
export const NEWS_WEEK =
  "News shows here when you open the app; nothing is sent to your phone yet. A planned task waits at least 14 days before any money can move, so open the app at least every 7 days.";
