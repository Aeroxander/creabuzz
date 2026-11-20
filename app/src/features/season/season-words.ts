/**
 * Every sentence of seasons and demo day (plan sections 5.3 and 7.7), in one place, and the server's refusals of an entry said
 * in plain words. Pure. A refusal is matched by its tail, so the server's prefix (`restricted:`, `invalid:`, `retry:`) may change
 * without breaking this; a refusal this file does not know is said as a plain "try again", never as the server's own text.
 */
import { dayText } from "../money/numbers";
import type { Phase, Season } from "./season-records";

/** The legal note under the demo-day list, word for word (plan 5.3). */
export const NOT_ADVICE =
  "Being on this page is not advice and is not a promise.";

export const BAND_TITLE = "Seasons";
export const DEMO_LIST_TITLE = "Projects showing what they made";
export const DEMO_EMPTY = "No project entered this season.";
export const DEMO_NOT_FOUND = "This season could not be found on this server.";
export const DEMO_UNREAD = "The season could not be read. Try again.";
export const DEMO_TRIM =
  "Some projects may not be shown: this season has more entries than can be read at once.";
export const NO_NUMBERS = "Its numbers are not here yet.";
export const NO_UPDATE = "No update yet.";
export const STALE_NUMBERS = "Its numbers could not be refreshed.";
export const SHOW_MORE = "Show more";
export const OPEN_PROJECT = "Open project";
export const SEE_DEMO_DAY = "See demo day";
export const SEE_THAT_DEMO_DAY = "See that demo day";
export const TRY_AGAIN = "Try again";

/** The band: one sentence for where the season stands. `k` is the projects in (null when it could not be read). */
export function bandWords(
  season: Season,
  phase: Phase,
  k: number | null,
): string {
  switch (phase) {
    case "upcoming":
      return `Season ${season.number} starts ${dayText(season.startsAt)}.`;
    case "open":
      return `Season ${season.number} is open. Projects can enter until demo day on ${dayText(season.demoDayAt)}.`;
    case "demo":
      if (k === null) return "Demo day: projects show what they made.";
      if (k === 0) return "Demo day: no project entered this season.";
      return k === 1
        ? "Demo day: 1 project shows what it made."
        : `Demo day: ${k.toLocaleString("en-GB")} projects show what they made.`;
    case "ended":
      return `No season is open. The last one ended ${dayText(season.endsAt)}.`;
  }
}

/** The dates of a season, for the top of its page. */
export function datesWords(season: Season): string {
  return `Starts ${dayText(season.startsAt)}. Demo day ${dayText(season.demoDayAt)}. Ends ${dayText(season.endsAt)}.`;
}

export const enterWords = (name: string) => `Enter ${name}`;
export const isInWords = (name: string) => `${name} is in.`;
export const LEAVE = "Leave";
export const ENTERED = (name: string) => `${name} is in the season.`;
export const LEFT = (name: string) => `${name} left the season.`;

/** The known refusals, by the tail of the sentence the server sends. */
const REFUSALS: [RegExp, string][] = [
  [
    /only (?:this project's |the )?team can (?:post this|enter)/i,
    "Only the team can enter a project.",
  ],
  [/already in this season/i, "This project is already in this season."],
  [/this season is full/i, "This season is full."],
  [
    /at most 3 projects in one season/i,
    "You have already entered 3 projects in this season.",
  ],
  [
    /taken out of this season|take a project out of a season/i,
    "This project was taken out of the season by the people who run this server.",
  ],
  [
    /at least 3 people have to back/i,
    "At least 3 people have to back this project first.",
  ],
  [
    /not launched on the network|has not launched/i,
    "The project has to be open to backers first.",
  ],
  [
    /changed its place in this season too often/i,
    "This project has changed its place in this season too many times.",
  ],
  [
    /this season is busy|try again in a moment/i,
    "Not ready yet. Try again in a minute.",
  ],
  [/not in this season/i, "This project is not in this season."],
  [
    /season is not open|not open for entry|season does not exist/i,
    "This season is not open for new projects now.",
  ],
  [/project is not here/i, "This project could not be found on this server."],
];

/** A refusal of an entry or a leave in plain words; a failure with no words for people says to try again. */
export function seasonRefusal(
  error: unknown,
  doing: "enter" | "leave",
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  for (const [pattern, words] of REFUSALS)
    if (pattern.test(message)) return words;
  return doing === "enter"
    ? "The project was not entered. Try again."
    : "The project was not taken out of the season. Try again.";
}
