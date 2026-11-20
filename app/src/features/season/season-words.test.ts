// The sentences of seasons: the band's five states, the refusals in plain words, and the lines the plan fixes word for word.
import { describe, expect, it } from "vitest";
import { dayText } from "../money/numbers";
import type { Season } from "./season-records";
import {
  bandWords,
  datesWords,
  enterWords,
  isInWords,
  NOT_ADVICE,
  seasonRefusal,
} from "./season-words";

const season: Season = {
  number: 4,
  startsAt: 1_800_000_000,
  demoDayAt: 1_803_628_800,
  endsAt: 1_804_233_600,
  signedAt: 1_800_000_000,
  id: "1".repeat(64),
};

describe("the band's words", () => {
  it("says each state with the season's number and dates", () => {
    expect(bandWords(season, "upcoming", null)).toBe(
      `Season 4 starts ${dayText(season.startsAt)}.`,
    );
    expect(bandWords(season, "open", null)).toBe(
      `Season 4 is open. Projects can enter until demo day on ${dayText(season.demoDayAt)}.`,
    );
    expect(bandWords(season, "ended", null)).toBe(
      `No season is open. The last one ended ${dayText(season.endsAt)}.`,
    );
  });

  it("says demo day with the number of projects, and does not guess a count it does not have", () => {
    expect(bandWords(season, "demo", 12)).toBe(
      "Demo day: 12 projects show what they made.",
    );
    expect(bandWords(season, "demo", 1)).toBe(
      "Demo day: 1 project shows what it made.",
    );
    expect(bandWords(season, "demo", 0)).toBe(
      "Demo day: no project entered this season.",
    );
    expect(bandWords(season, "demo", null)).toBe(
      "Demo day: projects show what they made.",
    );
  });

  it("the buttons carry the project's name, and the dates read in one line", () => {
    expect(enterWords("Moss")).toBe("Enter Moss");
    expect(isInWords("Moss")).toBe("Moss is in.");
    expect(datesWords(season)).toBe(
      `Starts ${dayText(season.startsAt)}. Demo day ${dayText(season.demoDayAt)}. Ends ${dayText(season.endsAt)}.`,
    );
  });

  it("the note under the list is the plan's, word for word", () => {
    expect(NOT_ADVICE).toBe(
      "Being on this page is not advice and is not a promise.",
    );
  });
});

describe("a refusal, in plain words", () => {
  const said = (message: string) => seasonRefusal(new Error(message), "enter");
  it.each([
    [
      "restricted: this project is already in this season",
      "This project is already in this season.",
    ],
    ["restricted: this season is full", "This season is full."],
    [
      "restricted: this season is not open for entry",
      "This season is not open for new projects now.",
    ],
    [
      "invalid: this season does not exist",
      "This season is not open for new projects now.",
    ],
    [
      "restricted: only this project's team can post this",
      "Only the team can enter a project.",
    ],
    // The same refusal as the app's general words turn it.
    [
      "Only this project's team can post this. If you should be on the team, ask the founder to add you to the project, then try again.",
      "Only the team can enter a project.",
    ],
    [
      "restricted: this project has not launched on the network yet",
      "The project has to be open to backers first.",
    ],
    [
      "restricted: at least 3 people have to back this project first",
      "At least 3 people have to back this project first.",
    ],
    [
      "restricted: a founder can enter at most 3 projects in one season",
      "You have already entered 3 projects in this season.",
    ],
    [
      "restricted: this project was taken out of this season",
      "This project was taken out of the season by the people who run this server.",
    ],
    [
      "retry: this season is busy; try again in a moment",
      "Not ready yet. Try again in a minute.",
    ],
    [
      "restricted: this project has changed its place in this season too often",
      "This project has changed its place in this season too many times.",
    ],
  ])("%s", (message, words) => {
    expect(said(message)).toBe(words);
  });

  it("a refusal it does not know is said as try again, never as the server's own text", () => {
    expect(said("error: database error: connection reset by peer")).toBe(
      "The project was not entered. Try again.",
    );
    expect(seasonRefusal(new Error("boom"), "leave")).toBe(
      "The project was not taken out of the season. Try again.",
    );
    expect(seasonRefusal("not an error", "enter")).toBe(
      "The project was not entered. Try again.",
    );
  });

  it("no sentence carries a kind number, a tag name or a code", () => {
    for (const message of [
      "restricted: this season is full",
      "invalid: this project is not in this season",
      "x",
    ])
      expect(said(message)).not.toMatch(
        /\b(?:kind|47003|37021|restricted|invalid|retry)\b/i,
      );
  });
});
