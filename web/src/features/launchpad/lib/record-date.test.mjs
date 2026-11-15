import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";

const { recordDate, recordDay } = await import("./record-date.ts");

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
