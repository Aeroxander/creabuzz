// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
// The share picture says no amount, no count of people, no gain figure and no price. The drawer takes any object shaped like a
// canvas context, so this test records every string it draws and scans them all (the banner line is taken out first: it holds
// the word "profit" in "Nothing here promises a profit").
import { describe, expect, it } from "vitest";
import { parseNumbers } from "../money/numbers";
import {
  exampleEvent,
  parsedExample,
  raw,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import { BANNER_LITERAL } from "../../../tests/helpers/legal-words";
import { projectPath } from "./project-record";
import {
  CARD_NAME_FALLBACK,
  CARD_PLAY_MONEY,
  CARD_WIDTH,
  cardAlt,
  cardContent,
  cardFileName,
  FORBIDDEN_ON_CARD,
  pitchForCard,
  wrapLines,
} from "./share-card";
import { type CardContext, drawShareCard } from "./share-card-draw";

function recorder() {
  const drawn: string[] = [];
  const ctx: CardContext = {
    fillStyle: "",
    font: "",
    textBaseline: "alphabetic",
    textAlign: "left",
    fillRect: () => undefined,
    fillText: (text) => {
      drawn.push(text);
    },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    arcTo: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
  };
  return { ctx, drawn };
}

const NOW = parsedExample().builtAt + 100;
const scanned = (drawn: string[]) => drawn.filter((s) => s !== BANNER_LITERAL);

describe("what the picture says", () => {
  it("every string drawn passes the forbidden pattern (banner taken out first), for the example's project", () => {
    const card = cardContent(
      { name: "Lantern", pitch: "Solar lamps for night markets." },
      parsedExample(),
      NOW,
    );
    const { ctx, drawn } = recorder();
    drawShareCard(ctx, card, "Creaton");
    expect(drawn).toContain(BANNER_LITERAL);
    expect(drawn).toContain("Lantern");
    expect(drawn).toContain("Solar lamps for night markets.");
    for (const text of scanned(drawn))
      expect(text, `"${text}" is on the picture`).not.toMatch(
        FORBIDDEN_ON_CARD,
      );
    // No digit but a count of weeks.
    for (const text of scanned(drawn))
      if (/\d/.test(text))
        expect(text).toMatch(/weeks? of check-ins in a row$/);
  });

  it("carries the example's own facts, from the record", () => {
    const n = parsedExample();
    const card = cardContent({ name: "Lantern", pitch: "" }, n, NOW);
    expect(card.facts).toEqual([
      "Open to back",
      `${n.streaks?.updates.weeks} weeks of check-ins in a row`,
    ]);
    expect(card.playMoney).toBe(CARD_PLAY_MONEY);
    expect(card.facts.length).toBeLessThanOrEqual(2);
  });

  it("leaves a founder's line off when it carries a currency sign, a percent sign or a word about price or gain", () => {
    for (const bad of [
      "Raise $50 for lamps",
      "Doubling your money in a year",
      "A 20% better lamp",
      "Great return on every lamp",
      "A good price for light",
      "Worth every minute",
      "Real value for markets",
      "Profit for everyone",
      "A gain for the street",
      "€5 lamps",
      "£5 lamps",
    ]) {
      expect(pitchForCard(bad), bad).toBe("");
      const { ctx, drawn } = recorder();
      drawShareCard(
        ctx,
        cardContent({ name: "Lantern", pitch: bad }, null, NOW),
        "Creaton",
      );
      expect(drawn, bad).not.toContain(bad);
    }
    expect(pitchForCard("  Solar   lamps\nfor night markets. ")).toBe(
      "Solar lamps for night markets.",
    );
  });

  it("says no fact it cannot back: a closed door, a stale record, no weeks", () => {
    const closed = parseNumbers(
      exampleEvent({
        ...(raw() as object),
        door: { ...(raw() as any).door, openNow: false },
      }),
      SERVER,
    );
    if (!closed || closed.removed) throw new Error("no");
    expect(
      cardContent({ name: "L", pitch: "" }, closed, NOW).facts,
    ).not.toContain("Open to back");
    // A record past a day says nothing about the door, and its run of updates has no "as of" on a picture: neither is said.
    const stale = cardContent(
      { name: "L", pitch: "" },
      parsedExample(),
      NOW + 3 * 86_400,
    );
    expect(stale.facts).not.toContain("Open to back");
    expect(stale.facts).toEqual([]);
    expect(cardContent({ name: "L", pitch: "" }, null, NOW).facts).toEqual([]);
  });

  it("leaves a name that carries an amount or a gain off the picture, and the share text, and names the project plainly instead", () => {
    for (const name of [
      "Raised $5M",
      "Up 300%",
      "100x gains",
      "Doubles your money",
      "Double your money: 10x returns, $5,000 each",
      "Back us with 1,000 dollars",
      "＄500 lamps",
      "Up ten times since launch",
    ]) {
      const card = cardContent({ name, pitch: "" }, null, NOW);
      expect(card.name, name).toBe(CARD_NAME_FALLBACK);
      expect(card.name).not.toMatch(FORBIDDEN_ON_CARD);
      const { ctx, drawn } = recorder();
      drawShareCard(ctx, card, "Creaton");
      expect(drawn.join("|"), name).not.toContain(name);
      expect(cardAlt(card)).not.toContain(name);
    }
    // A plain name, and one with a short plain number, stay as typed.
    expect(cardContent({ name: "Lantern", pitch: "" }, null, NOW).name).toBe(
      "Lantern",
    );
    expect(cardContent({ name: "Studio 54", pitch: "" }, null, NOW).name).toBe(
      "Studio 54",
    );
    expect(
      cardContent({ name: "  Night\n Market ", pitch: "" }, null, NOW).name,
    ).toBe("Night Market");
  });

  it("leaves a founder's line off when it states a gain or an amount in words a deny list would not know", () => {
    for (const pitch of [
      "Already 10x in a week",
      "5M raised, 3x soon",
      "Back us for 1000 dollars and watch it climb",
      "＄500 today",
      "Up ten times since launch",
    ]) {
      expect(pitchForCard(pitch), pitch).toBe("");
    }
    expect(pitchForCard("One lamp at a time, for night markets.")).toBe(
      "One lamp at a time, for night markets.",
    );
  });

  it("does not put a run of updates on a picture from a stale record, and says the unit's own length when it is not a week", () => {
    const fresh = cardContent({ name: "L", pitch: "" }, parsedExample(), NOW);
    expect(fresh.facts.join(" ")).toMatch(/weeks of check-ins in a row/);
    const old = cardContent(
      { name: "L", pitch: "" },
      parsedExample(),
      parsedExample().builtAt + 90 * 86_400,
    );
    expect(old.facts.join(" ")).not.toMatch(/weeks|updates/);
    const short = parseNumbers(
      exampleEvent({ ...(raw() as object), unit: 1_680 }),
      SERVER,
    );
    if (!short || short.removed) throw new Error("no");
    const facts = cardContent({ name: "L", pitch: "" }, short, NOW).facts.join(
      " ",
    );
    expect(facts).toMatch(/periods of 28 minutes/);
    expect(facts).not.toMatch(/weeks/);
  });

  it("says it is play money for a record that says so and for one that does not exist yet", () => {
    expect(cardContent({ name: "L", pitch: "" }, null, NOW).playMoney).toBe(
      CARD_PLAY_MONEY,
    );
  });

  it("has alt text with the name and the facts, a safe file name, and the link is the project's own", () => {
    const card = cardContent(
      { name: "Lantern", pitch: "x" },
      parsedExample(),
      NOW,
    );
    expect(cardAlt(card)).toBe(`Lantern. ${card.facts.join(". ")}`);
    expect(cardFileName("Lantern Lamps!", "Creaton")).toBe(
      "lantern-lamps-creaton.png",
    );
    expect(cardFileName("???", "")).toBe("project.png");
    expect(projectPath({ id: "lantern", author: "ab".repeat(32) })).toBe(
      `/p/lantern-${"ab".repeat(8)}`,
    );
  });
});

describe("wrapLines", () => {
  const measure = (s: string) => s.length * 10;
  it("breaks at the width, cuts with an ellipsis at the last line, and breaks a word wider than a line", () => {
    expect(wrapLines("one two three four", 90, measure, 5)).toEqual([
      "one two",
      "three",
      "four",
    ]);
    const cut = wrapLines("one two three four five six", 90, measure, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1].endsWith("…")).toBe(true);
    for (const line of wrapLines("abcdefghijklmnopqrstuvwxyz", 100, measure, 5))
      expect(measure(line)).toBeLessThanOrEqual(100);
    expect(CARD_WIDTH).toBe(1200);
  });
});
