/**
 * A length of time in words (`noticeWords`, `durationWords`): the two largest units that are there, rounded down, so a
 * notice is never read as longer than it is. On a real network a notice is days and hours ("14 days 12 hours"); on a test
 * network with a short time unit it is hours and minutes ("1 hour 17 minutes").
 */

const UNITS: readonly (readonly [string, number])[] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** "14 days 12 hours", "1 hour 17 minutes", "5 minutes", "20 seconds"; "no time" for nothing. */
export function durationWords(secs: number): string {
  const total = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0;
  const first = UNITS.findIndex(([, size]) => total >= size);
  if (first < 0) return "no time";
  const parts: string[] = [];
  let rest = total;
  // The largest unit that is there, and the one below it when it has something in it.
  for (const [name, size] of UNITS.slice(first, first + 2)) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}
