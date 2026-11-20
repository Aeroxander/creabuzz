// The two lines of a planned task: while it cannot be taken yet the date is the day to leave by; once it can be taken the line says
// leaving works on any day, the same as the news does.
import { describe, expect, it } from "vitest";
import { plannedWords } from "../../../alerts/alert-words";
import { plannedLines } from "../words";

describe("the lines of a planned task", () => {
  it("a plan that can already be taken must not tell the holder to leave 'before then' (the take window's end), and says the same as the news does", () => {
    const [, second] = plannedLines({
      max: 400_000_000n,
      name: null,
      what: null,
      date: 1_804_824_680,
      open: true,
    });
    // The news says "You can take your money out any time." for the same state; the strip's second line points "then" at the
    // end of the take window, as if leaving were only possible until then.
    expect(second).not.toMatch(/before then/);
    expect(second).toMatch(/^You can take your money out any time\./);
    expect(
      plannedWords({
        max: 400_000_000n,
        what: null,
        from: null,
        until: 1_804_824_680,
      }),
    ).toMatch(/any time/);
  });

  it("while it cannot be taken yet, the date is the day to leave by", () => {
    const [first, second] = plannedLines({
      max: 400_000_000n,
      name: null,
      what: null,
      date: 1_804_824_680,
      open: false,
    });
    expect(first).toMatch(/, from /);
    expect(second).toMatch(/^You can take your money out before then\./);
  });
});
