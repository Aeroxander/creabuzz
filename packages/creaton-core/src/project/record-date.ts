/**
 * One way to write a day on the weekly loop's pages: "Nov 15, 2026" in the reader's own language, with the short month
 * and the year always there. The project page, the tasks, the record, Work, Your projects and Home's feed all use it, so
 * two dates on one screen never read as `11/15/2026` beside `Nov 15`.
 *
 * Alias-free on purpose: `record-date.test.mjs` drives it under `node --test`.
 */

const FORMAT = { year: "numeric", month: "short", day: "numeric" } as const;

/** The day a moment (Unix seconds) falls on for the reader. `locale` is the reader's own unless a test names one. */
export function recordDay(seconds: number, locale?: string): string {
  return new Date(seconds * 1000).toLocaleDateString(locale, FORMAT);
}

/** A `YYYY-MM-DD` calendar date (a due date), written the same way and never moved a day by the reader's time zone. */
export function recordDate(date: string, locale?: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    ...FORMAT,
    timeZone: "UTC",
  });
}

const DAY_MS = 86_400_000;
/** "just now" holds for this long. */
const JUST_NOW_SECONDS = 5 * 60;

/** The calendar day a moment falls on for the reader, as a day number (so two days compare by subtraction). */
function localDayNumber(date: Date): number {
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  );
}

/**
 * When something happened, in the fewest words: "just now", "today", "yesterday", "3 days ago" (two to six days),
 * "Nov 9" in the same year, "Nov 9, 2025" before it. Days are the reader's own calendar days, so a post at 23:50 is
 * "yesterday" at 00:10. A moment ahead of now (a clock that is wrong) reads as "today", never a negative count.
 * `now` and `seconds` are Unix seconds.
 */
export function whenWords(
  seconds: number,
  now: number,
  locale?: string,
): string {
  if (now - seconds < JUST_NOW_SECONDS) return "just now";
  const then = new Date(seconds * 1000);
  const ago = localDayNumber(new Date(now * 1000)) - localDayNumber(then);
  if (ago <= 0) return "today";
  if (ago === 1) return "yesterday";
  if (ago < 7) return `${ago} days ago`;
  const sameYear = then.getFullYear() === new Date(now * 1000).getFullYear();
  return then.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * A due date in the fewest words: "today", "tomorrow", otherwise "Mon, Nov 23" (with the year when it is not this
 * one). `date` is a `YYYY-MM-DD` calendar date; anything else is returned as it came, never guessed at.
 */
export function dueWords(date: string, now: number, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const today = new Date(now * 1000);
  const ahead =
    Math.floor(Date.UTC(year, month - 1, day) / DAY_MS) - localDayNumber(today);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(year === today.getFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** `YYYY-MM-DD` for a moment, on the reader's own calendar. */
export function dayKey(seconds: number): string {
  const date = new Date(seconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
