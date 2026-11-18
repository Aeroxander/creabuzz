import { isWeeklyUpdateTags } from "@creaton/core/project/weekly-update.ts";
import { describe, expect, it } from "vitest";
import { weeklyUpdateRecord } from "./use-week";

describe("the weekly update record", () => {
  it("is the update record web/ reads as a weekly update, on the project's address", () => {
    const coordinate = `37001:${"a".repeat(64)}:demo`;
    const record = weeklyUpdateRecord(
      { coordinate },
      "  Shipped the sign-up page.  ",
      new Date(2026, 10, 18),
    );
    expect(record.kind).toBe(47003);
    expect(record.tags[0]).toEqual(["a", coordinate]);
    expect(record.tags).toContainEqual([
      "update-part",
      "done",
      "Shipped the sign-up page.",
    ]);
    expect(isWeeklyUpdateTags(record.tags)).toBe(true);
    // One field makes no promises: a "What's next" is the only place they come from.
    expect(record.tags.some((t) => t[0] === "promise")).toBe(false);
    const content = JSON.parse(record.content);
    expect(content.title).toBe("Week of 16 Nov");
    expect(content.body).toContain("Shipped the sign-up page.");
  });
});
