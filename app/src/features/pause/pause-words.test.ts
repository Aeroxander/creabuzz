import { describe, expect, it } from "vitest";
import {
  cardIntro,
  infoLine,
  launchSentence,
  lineWords,
  meterText,
  parkedPercent,
  parkSummary,
  stateLine,
  teamArmed,
  teamPaused,
  waitWords,
} from "./pause-words";

const S = 1_000_000_000_000_000_000n;
const B = 3_000n * S;

describe("the line and the wait", () => {
  it("says 'a third' only when the line is one third, otherwise '1 in n'", () => {
    expect(lineWords(3)).toBe("a third");
    expect(lineWords(5)).toBe("1 in 5");
    expect(lineWords(2)).toBe("1 in 2");
    for (const text of [
      cardIntro(4, 86_400),
      infoLine(4),
      launchSentence(4),
      teamArmed(4, 1_800_000_000),
      teamPaused(4, 1_800_000_000),
      stateLine({
        stage: "under",
        parkedTotal: 1n,
        backers: 100n * S,
        lineDivisor: 4,
        pausesFrom: null,
        since: null,
        line: 25n * S,
      }),
    ])
      expect(text).not.toMatch(/third/);
  });

  it("renders the wait from the pause's own day: one day at 86,400 seconds, plain words otherwise", () => {
    expect(waitWords(86_400)).toBe("one day");
    expect(waitWords(240)).toBe("4 minutes");
    expect(waitWords(60)).toBe("1 minute");
    expect(waitWords(30)).toBe("30 seconds");
    expect(waitWords(7_200)).toBe("2 hours");
    expect(waitWords(172_800)).toBe("2 days");
    expect(cardIntro(3, 240)).toMatch(/pause 4 minutes later/);
    expect(cardIntro(3, 86_400)).toMatch(/pause one day later/);
    expect(cardIntro(3, 240)).not.toMatch(/24 hours|one day/);
  });
});

describe("the parked share", () => {
  it("is rounded down to one decimal and never reads as the line while it is under it", () => {
    // a third of 3,000 is 1,000: 999.9 Shares parked is under the line but rounds to 33.3%
    const justUnder = 1_000n * S - S / 10n;
    expect(parkedPercent(justUnder, B, 3)).toBe("just under a third");
    expect(parkedPercent(1_000n * S, B, 3)).toBe("33.3%");
    expect(parkedPercent(500n * S, B, 3)).toBe("16.6%");
    expect(parkedPercent(0n, B, 3)).toBe("none");
    expect(parkedPercent(S, B, 3)).toBe("less than 1%");
    expect(parkedPercent(30n * S, B, 3)).toBe("1%");
  });

  it("works for a line that is not a third", () => {
    // under a line of exactly 50% the rounded-down figure is below it by itself
    expect(parkedPercent(1_500n * S - S / 10n, B, 2)).toBe("49.9%");
    expect(parkedPercent(1_500n * S, B, 2)).toBe("50%");
  });

  it("the Park sheet's summary names the share after parking, the line and the wait", () => {
    expect(
      parkSummary({
        n: 100n * S,
        parkedAfter: 400n * S,
        backers: B,
        divisor: 3,
        dayLength: 86_400,
      }),
    ).toBe(
      "You park 100 Shares. After this, 13.3% of backers' Shares are parked. At a third, the team's allowance and new task plans pause one day later.",
    );
    expect(
      parkSummary({
        n: 1n * S,
        parkedAfter: 1_000n * S - S / 10n,
        backers: B,
        divisor: 3,
        dayLength: 240,
      }),
    ).toMatch(
      /After this, just under a third of backers' Shares are parked\. At a third, .* pause 4 minutes later\.$/,
    );
  });

  it("the meter says its value in words, never by colour alone", () => {
    expect(meterText(500n * S, B, 3)).toBe("16.6% parked, a third needed");
    expect(meterText(0n, B, 3)).toBe("None parked, a third needed");
    expect(meterText(1_000n * S - S / 10n, B, 3)).toBe(
      "just under a third, a third needed",
    );
  });
});

describe("the state lines", () => {
  const base = {
    parkedTotal: 1_000n * S,
    backers: B,
    lineDivisor: 3,
    line: 1_000n * S,
  };
  it("under the line, armed and paused each say their own thing, and 'paused' never says parking stops a loss", () => {
    const under = stateLine({
      ...base,
      stage: "under",
      parkedTotal: 500n * S,
      pausesFrom: null,
      since: null,
    });
    expect(under).toBe(
      "16.6% of backers' Shares are parked. A third is needed.",
    );
    const armed = stateLine({
      ...base,
      stage: "armed",
      pausesFrom: 1_800_000_000,
      since: null,
    });
    expect(armed).toMatch(
      /^A third is parked\. The team's allowance and new task plans pause on .* if it stays there\.$/,
    );
    const paused = stateLine({
      ...base,
      stage: "paused",
      pausesFrom: 1_800_000_000,
      since: 1_800_000_000,
    });
    expect(paused).toMatch(/^Paused since /);
    expect(paused).toMatch(
      /The team cannot draw its allowance or plan new tasks while a third stays parked\. Tasks already planned go on\. Everyone can still take their money out\./,
    );
    expect(paused).toMatch(/It ends when 1 fewer Shares are parked\./);
    for (const text of [under, armed, paused, cardIntro(3, 86_400)])
      expect(text).not.toMatch(/\bloss\b|protect|safe|cannot lose/i);
  });

  it("the team's sentences are the plan's, with the line and the time", () => {
    expect(teamArmed(3, 1_800_000_000)).toMatch(
      /^Holders have parked a third of all Shares\. Your allowance and new task plans pause on .* if it stays there\. Until then you can draw what the box holds\.$/,
    );
    expect(teamPaused(3, 1_800_000_000)).toMatch(
      /^Paused by holders since .*\. You cannot draw the allowance or plan a new task until fewer than a third of Shares are parked\. You can still check in, finish tasks already planned, grant Team Shares and hand over\.$/,
    );
  });

  it("the launch sentence is said before launching", () => {
    expect(launchSentence(3)).toBe(
      "On this network holders can pause the team's spending when a third of Shares are parked. You cannot turn this off for your project.",
    );
  });
});
