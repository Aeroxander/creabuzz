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
