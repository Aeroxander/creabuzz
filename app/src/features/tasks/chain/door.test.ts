// The door rule (5.1): the allowance box for what it can hold, a plan with notice for what it cannot, and the share a plan
// asks for. Plus the lengths of time the sentences use.
import { describe, expect, it } from "vitest";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import type { ChainTasks } from "./types";
import { doorFor, durationWords, noticeWords, shareFor } from "./state";

const D = 1_000_000n;
const limits = (parsedExample().tasks as ChainTasks).limits;
const founder = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const worker = "0x00000000000000000000000000000000000000a1";
const runner = { address: founder, signers: null };
const notice = {
  noticeSecs: 14 * 86_400 + 12 * 3_600,
  takeWindowSecs: 604_800,
  dueSecs: 1_209_600,
};

const door = (over: Partial<Parameters<typeof doorFor>[0]> = {}) =>
  doorFor({
    usd: 40,
    box: 100n * D,
    boxCap: 100n * D,
    pot: 10_000n * D,
    payee: worker,
    runner,
    limits,
    notice,
    ...over,
  });

describe("doorFor", () => {
  it("a pay the box holds now goes from the box, with no notice, and a plan is offered beside it", () => {
    const d = door();
    expect(d.door).toBe("box");
    expect(d.sentence).toBe(
      "The allowance box holds 100 dollars now, enough to pay this on any day, with no notice.",
    );
    expect(d.planAlso).toBe(true);
  });

  it("at the cap the box still takes it; one unit over the cap it is planned", () => {
    const cap = 40n * D;
    expect(door({ box: cap, boxCap: cap }).door).toBe("box");
    const over = door({ box: cap - 1n, boxCap: cap - 1n });
    expect(over.door).toBe("plan");
    expect(over.sentence).toContain(
      "so it is planned: holders get 14 days 12 hours notice",
    );
    expect(over.sentence).toContain("anyone can take their money out first");
    expect(over.planAlso).toBe(false);
  });

  it("a pay above what the box holds but under what it can hold goes from the box later, and says when", () => {
    const d = door({ box: 10n * D, boxCap: 100n * D });
    expect(d.door).toBe("box");
    expect(d.sentence).toBe(
      "The allowance box holds 10 dollars now and fills up to 100 dollars. The team can pay this from the box once it holds 40 dollars, or plan it so holders get 14 days 12 hours notice first.",
    );
    expect(d.planAlso).toBe(true);
  });

  it("a box that holds nothing, with room to fill, is the box later", () => {
    expect(door({ box: 0n }).door).toBe("box");
  });

  it("no allowance (a box that cannot hold anything) means a plan", () => {
    const d = door({ box: 0n, boxCap: 0n });
    expect(d.door).toBe("plan");
    expect(d.sentence).toMatch(
      /^The allowance is not paying into the box, so this is planned/,
    );
  });

  it("more than one task may ask for is too big, with no press, and says what to do instead", () => {
    const big = door({ usd: 500, box: 0n, boxCap: 100n * D, pot: 1_000n * D });
    expect(big.door).toBe("too-big");
    expect(big.sentence).toBe(
      "This is more of the project's money than one task may ask for. Plan it in smaller parts, or pay part of it from the allowance.",
    );
    // with no allowance there is nothing to pay a part from
    expect(
      door({ usd: 500, box: 0n, boxCap: 0n, pot: 1_000n * D }).sentence,
    ).toBe(
      "This is more of the project's money than one task may ask for. Plan it in smaller parts.",
    );
  });

  it("a payee who runs the project can only be paid from the box, and never planned", () => {
    for (const payee of [founder, founder.toUpperCase().replace("0X", "0x")]) {
      const d = door({ payee, box: 0n, boxCap: 100n * D });
      expect(d.door).toBe("box-only");
      expect(d.planAlso).toBe(false);
    }
    const pair = {
      address: "0x00000000000000000000000000000000000000f0",
      signers: [worker, founder],
    };
    expect(door({ runner: pair }).door).toBe("box-only");
    expect(door({ runner: pair }).sentence).toBe(
      "A task paid to someone who runs the project cannot be planned. It can be paid from the allowance.",
    );
  });

  it("a box that holds the pay but a pay too big to plan is still the box, with no plan beside it", () => {
    const d = door({
      usd: 500,
      box: 600n * D,
      boxCap: 600n * D,
      pot: 1_000n * D,
    });
    expect(d.door).toBe("box");
    expect(d.planAlso).toBe(false);
  });

  it("without the notice (it could not be read) the sentence says notice and promises no length", () => {
    const d = door({
      usd: 500,
      box: 0n,
      boxCap: 100n * D,
      pot: 100_000n * D,
      notice: null,
    });
    expect(d.door).toBe("plan");
    expect(d.sentence).toContain("holders get notice before any money moves");
    expect(d.sentence).not.toMatch(/undefined|null|NaN/);
  });

  it("one dollar reads as one dollar", () => {
    expect(door({ usd: 1, box: 0n, boxCap: 100n * D }).sentence).toContain(
      "once it holds 1 dollar,",
    );
  });
});

describe("shareFor: a tenth more than the pay's own share of the project's money, in whole ten-thousandths", () => {
  const pot = 10_000n * D;
  it("rounds up and is at least 1", () => {
    // 1% of the pot asks for 1.1%
    expect(shareFor(100n * D, pot, 500)).toBe(110);
    // a tiny pay still asks for something
    expect(shareFor(1n, pot, 500)).toBe(1);
    // rounded up, never down: the pay's share is 3333333.. ten-millionths
    expect(shareFor(1n * D, 3n * D, 500)).toBeNull();
    expect(shareFor(333_333n, 10_000n * D, 500)).toBe(1);
  });
  it("at 5% of the project's money the margin is over the most one task may ask for", () => {
    expect(shareFor((pot * 5n) / 100n, pot, 500)).toBeNull();
  });
  it("at about 4.55% it is over; at 4.5% it fits exactly, and one unit more is over", () => {
    expect(shareFor((pot * 455n) / 10_000n, pot, 500)).toBeNull();
    expect(shareFor((pot * 450n) / 10_000n, pot, 500)).toBe(495);
    // the largest pay that still fits is the one whose share is exactly the limit
    const most = (pot * 500n) / 11_000n;
    expect(shareFor(most, pot, 500)).toBe(500);
    expect(shareFor(most + 1n, pot, 500)).toBeNull();
  });
  it("nothing for a pot of nothing or a pay of nothing", () => {
    expect(shareFor(1n * D, 0n, 500)).toBeNull();
    expect(shareFor(0n, pot, 500)).toBeNull();
  });
  it("follows the limit the record gives, not a fixed 5%", () => {
    expect(shareFor(100n * D, pot, 100)).toBeNull();
    expect(shareFor(100n * D, pot, 110)).toBe(110);
  });
});

describe("lengths of time", () => {
  it("days and hours on a real network", () => {
    expect(noticeWords(14 * 86_400 + 12 * 3_600)).toBe("14 days 12 hours");
    expect(durationWords(7 * 86_400)).toBe("7 days");
    expect(durationWords(86_400)).toBe("1 day");
    expect(durationWords(14 * 86_400 + 90 * 60)).toBe("14 days 1 hour");
  });
  it("hours and minutes on a test network's short unit", () => {
    expect(noticeWords(3_600 + 17 * 60)).toBe("1 hour 17 minutes");
    expect(durationWords(2 * 3_600)).toBe("2 hours");
    expect(durationWords(5 * 60)).toBe("5 minutes");
    expect(durationWords(61)).toBe("1 minute 1 second");
    expect(durationWords(20)).toBe("20 seconds");
  });
  it("rounds down, so a notice is never read as longer than it is", () => {
    expect(durationWords(14 * 86_400 + 12 * 3_600 + 3_599)).toBe(
      "14 days 12 hours",
    );
    expect(durationWords(86_400 + 59 * 60)).toBe("1 day");
  });
  it("nothing, and what is not a number, read as no time", () => {
    expect(durationWords(0)).toBe("no time");
    expect(durationWords(-5)).toBe("no time");
    expect(durationWords(Number.NaN)).toBe("no time");
  });
  it("the notice of the example's own plans is what its rows say", () => {
    const row = (parsedExample().tasks as ChainTasks).list.find(
      (r) => r.state === "announced",
    );
    expect(row).toBeDefined();
    const secs = (row?.noticeEnd ?? 0) - (row?.announcedAt ?? 0);
    expect(noticeWords(secs)).toMatch(/^\d+ days( \d+ hours?)?$/);
  });
});
