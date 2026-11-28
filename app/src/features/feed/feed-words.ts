/**
 * The sentences of the live feed ("Lately", plan section 7.5), made from the signed record's `feed` key and nothing else.
 * Pure, so one test holds every sentence. Joins and take-outs are said with the same words in the same order and weight; the
 * only amount is the net money in, rounded by the server, and it is never called volume.
 */
import type { FeedHour, FeedItem } from "../money/numbers-types";
import { timeText } from "../money/numbers";
import { smallDollarsText } from "../money/copy";
import { durationWords } from "../tasks/chain/duration";

export const FEED_TITLE = "Lately";
export const FEED_EMPTY = "Nothing has happened here lately.";
export const SHOW_EARLIER = "Show earlier";
export const SHOW_BY_THE_HOUR = "Show by the hour";
export const HIDE_BY_THE_HOUR = "Hide the hours";

/** "1 dollar", "100 dollars": an amount in a sentence (the feed's amounts are whole hundreds). */
export function feedDollars(raw: bigint): string {
  return raw === 1_000_000n ? "1 dollar" : `${smallDollarsText(raw)} dollars`;
}

/** Under the title: how the amounts are rounded, and that no one is named. */
export function roundingNote(roundTo: bigint): string {
  return `Amounts are rounded to the nearest ${feedDollars(roundTo)}. No names are shown.`;
}

/** What one thing the team or a worker did is called, with when it happened and, where it matters, the date it points to. */
export function itemWords(item: FeedItem, now: number): string {
  const date = item.date === null ? null : timeText(item.date);
  switch (item.kind) {
    case "task_planned":
      // "You can take your money out first" is only true while the notice runs: after its date the task may be taken.
      if (item.date !== null && item.date <= now)
        return `A task was planned. It could be taken from ${date}.`;
      return date
        ? `A task was planned. It can be taken from ${date}. You can take your money out first.`
        : "A task was planned. You can take your money out first.";
    case "task_taken":
      return date
        ? `A task was taken. It is due ${date}.`
        : "A task was taken.";
    case "task_paid":
      return "A task was paid.";
    case "task_ended":
      return "A task ended without being paid.";
    case "task_withdrawn":
      return "A plan was withdrawn.";
    case "update":
      return "The team checked in.";
  }
}

/** One count, said the same way for a join and for a take-out. */
export function backedWords(n: number): string {
  return `${n.toLocaleString("en-GB")} backed`;
}
export function tookOutWords(n: number): string {
  return `${n.toLocaleString("en-GB")} took out`;
}

/** The length the hour buckets cover, in words: "2 days" on a real network, minutes on a test one. */
export function coverWords(hours: readonly FeedHour[], bucketSecs: number) {
  return durationWords(hours.length * bucketSecs);
}

/** What the buckets in a window add up to. */
export interface FeedSum {
  joins: number;
  tookOut: number;
  /** Money in less money out, each bucket already rounded by the server (negative: more went out). */
  net: bigint;
  /** Whether any bucket had a join or a take-out. */
  moved: boolean;
  /**
   * Whether an hour with a join or a take-out rounded to no money at all. The server rounds each hour on its own, so the
   * sum of the hours says nothing true once one of them was too small to show.
   */
  hidden: boolean;
}

/** Adds up buckets: counts and the signed net. Never reads more than the buckets it is given. */
export function sumHours(hours: readonly FeedHour[]): FeedSum {
  let joins = 0;
  let tookOut = 0;
  let net = 0n;
  let hidden = false;
  for (const h of hours) {
    joins += h.joins;
    tookOut += h.tookOut;
    if (h.joins + h.tookOut > 0 && h.net.dir === "even") hidden = true;
    if (h.net.dir === "in") net += h.net.amount;
    else if (h.net.dir === "out") net -= h.net.amount;
  }
  return { joins, tookOut, net, moved: joins + tookOut > 0, hidden };
}

/**
 * The sentence under the counts. About as much as the rounding can say: a sum that rounds to nothing with one side only
 * says the amounts were too small to show, never that as much went out as came in; and with any hour that rounded to nothing
 * it says there is no total.
 */
export function netSentence(sum: {
  joins: number;
  tookOut: number;
  net: bigint;
  hidden?: boolean;
}): string {
  // An hour that rounded to nothing hides what it held: no total is said over it, never "about as much".
  if (sum.hidden)
    return "Some amounts were too small to show, so there is no total.";
  if (sum.net > 0n)
    return `About ${feedDollars(sum.net)} more came in than went out.`;
  if (sum.net < 0n)
    return `About ${feedDollars(-sum.net)} more went out than came in.`;
  if (sum.joins > 0 && sum.tookOut > 0)
    return "About as much came in as went out.";
  return "The amounts were too small to show.";
}

/** The label of an hour row: the hour's first moment. */
export function hourLabel(h: FeedHour): string {
  return timeText(h.at);
}
