// The sentences and figures the money screens say: amounts of Shares and dollars, a rate, where a project stands and what
// that means, and why the door is shut. No protocol word, event name or contract name is in any of them.
import { describe, expect, it } from "vitest";
import { numbersFor, S } from "../../../tests/helpers/pot-harness";
import {
  allowanceWords,
  doorShutWords,
  rateWords,
  sharesWords,
  smallDollarsText,
  spanWords,
  stateWords,
  teamPartPercent,
} from "./pot-words";

const numbers = numbersFor();

describe("amounts", () => {
  it("Shares: whole when whole or large, two decimals for a part of a Share", () => {
    expect(sharesWords(0n)).toBe("0");
    expect(sharesWords(1_020n * S)).toBe("1,020");
    expect(sharesWords(S)).toBe("1");
    expect(sharesWords(S / 2n)).toBe("0.50");
    expect(sharesWords(12n * S + S / 4n)).toBe("12");
    expect(sharesWords(3n * S + S / 4n)).toBe("3.25");
    expect(sharesWords(1_234_567n * S)).toBe("1,234,567");
  });
  it("what one Share gives: cents above a dollar, up to six decimals below it", () => {
    expect(smallDollarsText(10_058n)).toBe("0.010058");
    expect(smallDollarsText(9_800n)).toBe("0.0098");
    expect(smallDollarsText(500_000n)).toBe("0.50");
    expect(smallDollarsText(0n)).toBe("0.00");
    expect(smallDollarsText(2_500_000n)).toBe("2.50");
  });
  it("a daily rate", () => {
    expect(rateWords(1_000)).toBe("0.10%");
    expect(rateWords(2_000)).toBe("0.20%");
    expect(rateWords(0)).toBe("0.00%");
  });
  it("a span", () => {
    expect(spanWords(3 * 86_400)).toBe("about 3 days");
    expect(spanWords(86_400)).toBe("about 1 day");
    expect(spanWords(3_600)).toBe("less than a day");
  });
});

describe("the allowance and the Team's part", () => {
  it("says the daily limit, what it is today and what the box holds", () => {
    const words = allowanceWords(numbers);
    expect(words).toMatch(
      /up to 0\.10% of the project's money a day \(about 7\.32 dollars today\)/,
    );
    expect(words).toMatch(/It holds 43\.97 dollars now/);
  });
  it("an allowance switched off says nothing goes into the box", () => {
    const off = { ...numbers, allowance: { ...numbers.allowance, ratePpm: 0 } };
    expect(allowanceWords(off)).toMatch(/switched off/);
  });
  it("the Team's part is a whole percent, and none without Team Shares", () => {
    expect(teamPartPercent(numbers)).toBe(93);
    expect(
      teamPartPercent({
        ...numbers,
        shares: { ...numbers.shares, teamCounted: 0n },
      }),
    ).toBeNull();
  });
});

describe("where the project stands", () => {
  const q = numbers.quiet;
  it("open: when the team checked in, and when it would go quiet", () => {
    const s = stateWords(numbers, numbers.builtAt);
    expect(s.label).toBe("Open");
    expect(s.meaning).toMatch(/checked in on .*goes quiet/);
    expect(s.meaning).toMatch(/take your money out any time/);
  });
  it("quiet, dormant, open to wind down, wound down", () => {
    expect(stateWords(numbers, (q.quietFrom ?? 0) + 1).label).toBe("Quiet");
    expect(stateWords(numbers, (q.dormantFrom ?? 0) + 1).label).toBe("Dormant");
    expect(stateWords(numbers, (q.windableFrom ?? 0) + 1).label).toBe(
      "Can be wound down",
    );
    const wound = {
      ...numbers,
      windDown: { kind: 1 as const, at: numbers.builtAt },
    };
    expect(stateWords(wound, numbers.builtAt).label).toBe("Wound down");
    expect(stateWords(wound, numbers.builtAt).meaning).toMatch(
      /take yours out/,
    );
  });
  it("every state says taking out still works, or is what is left", () => {
    for (const at of [
      numbers.builtAt,
      (q.quietFrom ?? 0) + 1,
      (q.dormantFrom ?? 0) + 1,
      (q.windableFrom ?? 0) + 1,
    ])
      expect(stateWords(numbers, at).meaning).toMatch(
        /take your money out any time/,
      );
  });
});

describe("why the door is shut", () => {
  it("nothing while it is open", () => {
    expect(doorShutWords(numbers, numbers.builtAt)).toBeNull();
  });
  it("the founder's switch, the team gone quiet, a wound-down project", () => {
    const closed = {
      ...numbers,
      door: { ...numbers.door, switchOn: false, openNow: false },
    };
    expect(doorShutWords(closed, numbers.builtAt)).toMatch(
      /closed the door to new backing/,
    );
    expect(doorShutWords(numbers, (numbers.quiet.quietFrom ?? 0) + 1)).toMatch(
      /has not checked in since/,
    );
    const wound = {
      ...numbers,
      windDown: { kind: 1 as const, at: numbers.builtAt },
    };
    expect(doorShutWords(wound, numbers.builtAt)).toMatch(/wound down/);
  });
});

describe("plain words", () => {
  it("none of the money screens' sentences carries a protocol word", () => {
    const all = [
      allowanceWords(numbers),
      stateWords(numbers, numbers.builtAt).meaning,
      stateWords(numbers, (numbers.quiet.quietFrom ?? 0) + 1).meaning,
      doorShutWords(numbers, (numbers.quiet.quietFrom ?? 0) + 1) ?? "",
    ].join(" ");
    for (const word of [
      /\bkind\b/i,
      /\bNIP\b/,
      /\brelay\b/i,
      /\bnsec\b/i,
      /\bwei\b/i,
      /\bERC\b/,
      /\brevert/i,
    ])
      expect(all).not.toMatch(word);
  });
});
