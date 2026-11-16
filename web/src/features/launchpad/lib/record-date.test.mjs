import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";

const { dayKey, dueWords, recordDate, recordDay, whenWords } = await import(
  "./record-date.ts"
);

const features = fileURLToPath(new URL("../../", import.meta.url));

/** The weekly loop's pages that write a day: each takes it from `record-date.ts`. */
const PAGES = [
  "launchpad/ui/ProjectGoalCard.tsx",
  "launchpad/ui/ProjectRecordCard.tsx",
  "launchpad/ui/TaskParts.tsx",
  "launchpad/ui/ProjectOpenHelp.tsx",
  "work/ui/YourWork.tsx",
  "portfolio/ui/YourProjects.tsx",
  "feed/ui/ProjectProgressFeed.tsx",
];

test("a day reads the same everywhere: short month, day and year", () => {
  // 2026-11-15T12:00:00Z
  assert.equal(recordDay(1_794_744_000, "en-US"), "Nov 15, 2026");
  assert.equal(recordDate("2026-11-15", "en-US"), "Nov 15, 2026");
  assert.equal(recordDate("2099-01-15", "en-US"), "Jan 15, 2099");
  // Never the all-number form, which reads as two different days in two countries.
  assert.doesNotMatch(recordDay(1_794_744_000, "en-US"), /\d+\/\d+/);
});

test("a due date is not moved a day by the reader's time zone", () => {
  const before = process.env.TZ;
  try {
    for (const zone of ["Pacific/Auckland", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      assert.equal(recordDate("2026-11-15", "en-US"), "Nov 15, 2026", zone);
    }
  } finally {
    process.env.TZ = before;
  }
});

test("the weekly loop's pages write their days with the one helper, not a format of their own", () => {
  for (const page of PAGES) {
    const text = readFileSync(`${features}${page}`, "utf8");
    assert.match(text, /record-date/, `${page} uses record-date`);
    assert.doesNotMatch(
      text,
      /toLocaleDateString\(/,
      `${page} formats a date itself`,
    );
  }
});

const at = (iso) => Date.parse(iso) / 1000;
// Monday 2026-11-16, midday.
const NOW = at("2026-11-16T12:00:00Z");
const ago = (days, hours = 0) => NOW - days * 86_400 - hours * 3_600;

test("when something happened: just now, today, yesterday, days ago, then a date", () => {
  const words = (seconds, now = NOW) => whenWords(seconds, now, "en-US");
  assert.equal(words(NOW - 30), "just now");
  assert.equal(words(NOW - 4 * 60), "just now");
  assert.equal(words(ago(0, 2)), "today");
  assert.equal(words(ago(1)), "yesterday");
  assert.equal(words(ago(2)), "2 days ago");
  assert.equal(words(ago(3)), "3 days ago");
  assert.equal(words(ago(6)), "6 days ago");
  // From a week on it is a date, with no year while it is this year.
  assert.equal(words(ago(7)), "Nov 9");
  assert.equal(words(ago(8)), "Nov 8");
  assert.equal(words(ago(15)), "Nov 1");
  // Days are calendar days: 23:50 last night is yesterday at 00:10, though it was twenty minutes ago.
  assert.equal(
    words(at("2026-11-15T23:50:00Z"), at("2026-11-16T00:10:00Z")),
    "yesterday",
  );
  // A clock that is wrong never reads as a negative count.
  assert.equal(words(NOW + 3 * 86_400), "just now");
  assert.equal(words(NOW + 3 * 86_400, NOW - 10 * 86_400), "just now");
});

test("a date in an earlier year carries its year, and the year boundary is the calendar's, not 365 days", () => {
  const words = (seconds, now) => whenWords(seconds, now, "en-US");
  const jan3 = at("2027-01-03T12:00:00Z");
  assert.equal(words(at("2026-12-28T12:00:00Z"), jan3), "6 days ago");
  assert.equal(words(at("2026-12-20T12:00:00Z"), jan3), "Dec 20, 2026");
  assert.equal(words(at("2027-01-01T08:00:00Z"), jan3), "2 days ago");
  assert.equal(words(at("2026-11-09T12:00:00Z"), NOW), "Nov 9");
  assert.equal(words(at("2025-11-09T12:00:00Z"), NOW), "Nov 9, 2025");
  // Several words, never the all-number form.
  assert.doesNotMatch(words(ago(40), NOW), /\d+\/\d+/);
});

test("a due date: today, tomorrow, then the weekday and day", () => {
  const due = (date) => dueWords(date, NOW, "en-US");
  assert.equal(due("2026-11-16"), "today");
  assert.equal(due("2026-11-17"), "tomorrow");
  assert.equal(due("2026-11-22"), "Sun, Nov 22");
  assert.equal(due("2026-11-23"), "Mon, Nov 23");
  assert.equal(due("2026-11-24"), "Tue, Nov 24");
  assert.equal(due("2026-12-01"), "Tue, Dec 1");
  // Another year says so.
  assert.equal(due("2027-01-04"), "Mon, Jan 4, 2027");
  // A date that is not one is returned as it came.
  assert.equal(due("next week"), "next week");
});

test("a due date is the calendar day, whatever the reader's time zone", () => {
  const before = process.env.TZ;
  try {
    for (const zone of ["Pacific/Auckland", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      // 2026-11-16 12:00 UTC is already the 17th in Auckland and still the 16th in Los Angeles.
      const today = dayKey(NOW);
      assert.equal(dueWords(today, NOW, "en-US"), "today", zone);
      assert.equal(
        dueWords("2026-11-23", NOW, "en-US").endsWith("Nov 23"),
        true,
      );
    }
  } finally {
    process.env.TZ = before;
  }
});
