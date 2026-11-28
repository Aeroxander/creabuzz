/**
 * What the live feed draws, from the record's `feed` key: the newest items a few at a time and the hours in which something
 * moved. Pure. The record carries every hour as a bucket (a quiet hour is a zero bucket); a quiet hour is never drawn.
 */
import type { FeedHour, FeedItem } from "../money/numbers-types";

/** How many items show first, and how many more each press of "Show earlier" adds. */
export const FIRST_ITEMS = 3;
export const MORE_ITEMS = 10;

/** The items to draw when `shown` of them are open: newest first, as the record has them. Never more than there are. */
export function shownItems(
  items: readonly FeedItem[],
  shown: number,
): FeedItem[] {
  return items.slice(0, Math.max(0, shown));
}

/** The hours in which somebody backed or took out, newest first. Hours with nothing are left out. */
export function movedHours(hours: readonly FeedHour[]): FeedHour[] {
  return hours
    .filter((h) => h.joins + h.tookOut > 0)
    .sort((a, b) => b.at - a.at);
}

/** One hour's net money in as a signed amount (negative: more went out). */
export function signedNet(h: FeedHour): bigint {
  if (h.net.dir === "in") return h.net.amount;
  if (h.net.dir === "out") return -h.net.amount;
  return 0n;
}
