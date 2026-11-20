/**
 * A count of the project's time units in words. On a real network a unit is one week and is said so; on a test network with a
 * short unit it is said as that length ("3 periods of 28 minutes"), never as weeks it is not.
 */
import { durationWords } from "../tasks/chain/duration";

/** One real week, in seconds. */
export const WEEK_SECS = 604_800;

/** "1 week", "14 weeks"; for any other unit "1 period of 28 minutes", "14 periods of 28 minutes". */
export function unitCount(n: number, unit: number): string {
  const count = n.toLocaleString("en-GB");
  if (unit === WEEK_SECS) return `${count} ${n === 1 ? "week" : "weeks"}`;
  return `${count} ${n === 1 ? "period" : "periods"} of ${durationWords(unit)}`;
}
