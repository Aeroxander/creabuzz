// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
// The sentences of the live feed, from the example the server's own code wrote: every figure is read from the parsed record.
import { describe, expect, it } from "vitest";
import { parseNumbers } from "../money/numbers";
import {
  exampleEvent,
  parsedExample,
  raw,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import { timeText } from "../money/numbers";
import {
  backedWords,
  coverWords,
  feedDollars,
  itemWords,
  netSentence,
  roundingNote,
  sumHours,
  tookOutWords,
} from "./feed-words";

type Json = Record<string, any>;
const feedOf = (change?: (feed: Json) => void) => {
  const c = raw() as Json;
  change?.(c.feed);
  const n = parseNumbers(exampleEvent(c), SERVER);
  if (!n || n.removed || !n.feed) throw new Error("no feed");
  return n.feed;
};

describe("the items, in the words of the plan", () => {
  it("says each of the six kinds, with its date where it has one", () => {
    const feed = parsedExample().feed;
    if (!feed) throw new Error("the example has a feed");
    const said = new Map(feed.items.map((i) => [i.kind, i]));
    // The example has every kind in it.
    for (const kind of [
      "task_planned",
      "task_taken",
      "task_paid",
      "task_ended",
      "task_withdrawn",
      "update",
    ] as const)
      expect(said.has(kind)).toBe(true);
    const planned = said.get("task_planned");
    const taken = said.get("task_taken");
    if (!planned?.date || !taken?.date) throw new Error("dates");
    const before = planned.date - 86_400;
    expect(itemWords(planned, before)).toBe(
      `A task was planned. It can be taken from ${timeText(planned.date)}. You can take your money out first.`,
    );
    expect(itemWords(taken, before)).toBe(
      `A task was taken. It is due ${timeText(taken.date)}.`,
    );
    const paid = said.get("task_paid");
    const ended = said.get("task_ended");
    const withdrawn = said.get("task_withdrawn");
    const update = said.get("update");
    if (!paid || !ended || !withdrawn || !update) throw new Error("kinds");
    expect(itemWords(paid, before)).toBe("A task was paid.");
    expect(itemWords(ended, before)).toBe("A task ended without being paid.");
    expect(itemWords(withdrawn, before)).toBe("A plan was withdrawn.");
    expect(itemWords(update, before)).toBe("The team checked in.");
  });

  it("never says a price, a gain, a volume, a name or an address", () => {
    const feed = parsedExample().feed;
    if (!feed) throw new Error("feed");
    const all = feed.items.map((i) => itemWords(i, 0)).join(" ");
    expect(all).not.toMatch(/volume|price|gain|profit|return|0x|\$/i);
  });
});

describe("the counts and the net", () => {
  it("says joins and take-outs in the same form", () => {
    expect(backedWords(3)).toBe("3 backed");
    expect(tookOutWords(1)).toBe("1 took out");
    expect(backedWords(1200)).toBe("1,200 backed");
  });

  it("adds the buckets' counts and signed nets", () => {
    const feed = feedOf((f) => {
      f.hours[45].joins = 2;
      f.hours[45].net = { dir: "in", amount: "300000000" };
      f.hours[46].tookOut = 1;
      f.hours[46].net = { dir: "out", amount: "100000000" };
    });
    const sum = sumHours(feed.hours);
    const joinsInRecord = feed.hours.reduce((n, h) => n + h.joins, 0);
    expect(sum.joins).toBe(joinsInRecord);
    expect(sum.net).toBe(
      300n * 1_000_000n - 100n * 1_000_000n - 400n * 1_000_000n,
    );
  });

  it("says three net sentences, and a net that rounds to nothing from one side as too small to show", () => {
    const more = (net: bigint) => netSentence({ joins: 1, tookOut: 1, net });
    expect(more(500_000_000n)).toBe(
      `About ${feedDollars(500_000_000n)} more came in than went out.`,
    );
    expect(more(-200_000_000n)).toBe(
      `About ${feedDollars(200_000_000n)} more went out than came in.`,
    );
    expect(more(0n)).toBe("About as much came in as went out.");
    // A join of 40 dollars rounds to nothing: it is never said as "as much went out".
    expect(netSentence({ joins: 1, tookOut: 0, net: 0n })).toBe(
      "The amounts were too small to show.",
    );
    expect(netSentence({ joins: 0, tookOut: 2, net: 0n })).toBe(
      "The amounts were too small to show.",
    );
  });

  it("never says 'about as much' over an hour that rounded to nothing: five small backs and one small take-out give no total", () => {
    const even = { dir: "even" as const, amount: 0n };
    const hours = [
      ...Array.from({ length: 5 }, (_, i) => ({
        at: i * 3600,
        joins: 1,
        tookOut: 0,
        net: even,
      })),
      { at: 5 * 3600, joins: 0, tookOut: 1, net: even },
    ];
    const sum = sumHours(hours);
    expect(sum.joins).toBe(5);
    expect(sum.tookOut).toBe(1);
    expect(sum.hidden).toBe(true);
    expect(netSentence(sum)).toBe(
      "Some amounts were too small to show, so there is no total.",
    );
    // Hours that all carry a figure still add up as before.
    const clear = sumHours([
      {
        at: 0,
        joins: 1,
        tookOut: 0,
        net: { dir: "in" as const, amount: 100_000_000n },
      },
      {
        at: 3600,
        joins: 0,
        tookOut: 1,
        net: { dir: "out" as const, amount: 100_000_000n },
      },
    ]);
    expect(clear.hidden).toBe(false);
    expect(netSentence(clear)).toBe("About as much came in as went out.");
  });

  it("does not say 'you can take your money out first' once the notice has run out", () => {
    const planned = {
      kind: "task_planned" as const,
      at: 1,
      serial: 3,
      date: 5_000,
    };
    expect(itemWords(planned, 6_000)).toBe(
      `A task was planned. It could be taken from ${timeText(5_000)}.`,
    );
    expect(itemWords(planned, 4_000)).toMatch(
      /You can take your money out first\./,
    );
  });

  it("names the rounding from the record's own step and the window from its own hours", () => {
    const feed = parsedExample().feed;
    if (!feed) throw new Error("feed");
    expect(roundingNote(feed.roundTo)).toBe(
      `Amounts are rounded to the nearest ${feedDollars(feed.roundTo)}.`,
    );
    expect(roundingNote(feed.roundTo)).toContain("100 dollars");
    expect(coverWords(feed.hours, feed.bucketSecs)).toBe("2 days");
  });
});
