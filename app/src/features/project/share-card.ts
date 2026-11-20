/**
 * What the share picture says (plan section 7.2): the project's name, its line, at most two facts, the fixed banner and the
 * play-money line, and nothing else. **No amount, no count of people, no gain figure, no price**: the words are chosen
 * here and every string the drawing puts on the picture comes from this file, so a test that records them can scan them.
 * Pure: the drawing is `share-card-draw.ts`.
 */
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { type ProjectNumbers, freshnessOf } from "../money/numbers";
import { doorShutWords, TAKE_OUT_BANNER } from "../pot/pot-words";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const CARD_PLAY_MONEY = "Play money on a test network.";

/** Words and signs that must never be on the card: an amount, a price, a gain, a count of people. A test scans every string drawn. */
export const FORBIDDEN_ON_CARD =
  /[$€£¥%]|\b(price|prices|gain|gains|return|returns|profit|worth|value|earn\w*|dividends?|payouts?|apy|invest\w*|yield)\b|\b\d[\d,.]*\s*(people|persons?|backers?|holders?|investors?|accounts?)\b/i;

/** More words a founder's own line must not carry onto the card: they speak of making money, which the card never does. */
const FOUNDER_WORDS_LEFT_OFF =
  /\b(money|cash|income|wealth|rich|doubl\w*|interest|passive)\b/i;

/**
 * The founder's line, or nothing: a founder's own words can carry what the card must not (a currency sign, a percent sign,
 * a word about price, gain, return, profit, worth or value, or about making money), so such a line is left off and the card
 * is only its name.
 */
export function pitchForCard(pitch: string): string {
  const flat = pitch.replace(/\s+/g, " ").trim();
  return flat === "" ||
    FORBIDDEN_ON_CARD.test(flat) ||
    FOUNDER_WORDS_LEFT_OFF.test(flat)
    ? ""
    : flat;
}

export interface CardContent {
  name: string;
  /** The founder's line as it will be drawn (already filtered). */
  pitch: string;
  /** At most two facts. */
  facts: string[];
  /** The fixed banner, and the play-money line when the record says so. */
  banner: string;
  playMoney: string | null;
}

/**
 * Everything the card says. The facts are what the record can say without an amount: whether the door is open (only while the
 * record is not too old to say) and the weeks of updates in a row (from one week).
 */
export function cardContent(
  input: { name: string; pitch: string },
  numbers: ProjectNumbers | null,
  now: number,
): CardContent {
  const facts: string[] = [];
  if (
    numbers &&
    freshnessOf(numbers, now).level !== "stale" &&
    doorShutWords(numbers, now) === null
  )
    facts.push("Open to back");
  const weeks = numbers?.streaks?.updates.weeks ?? 0;
  if (weeks >= 1)
    facts.push(
      `${weeks} ${weeks === 1 ? "week" : "weeks"} of updates in a row`,
    );
  return {
    name: input.name.replace(/\s+/g, " ").trim(),
    pitch: pitchForCard(input.pitch),
    facts: facts.slice(0, 2),
    banner: TAKE_OUT_BANNER,
    // A record that does not say counts as play money (the safe answer), so does a project with no record yet.
    playMoney: mustSayPlayMoney(numbers?.playMoney) ? CARD_PLAY_MONEY : null,
  };
}

/** The picture's alt text: the name and what it says. */
export function cardAlt(card: CardContent): string {
  return [card.name, ...card.facts].join(". ");
}

/** A file name for the saved picture: letters, digits and hyphens only. */
export function cardFileName(name: string, app: string): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const parts = [slug(name), slug(app)].filter(Boolean);
  return `${parts.length > 0 ? parts.join("-") : "project"}.png`;
}

/** Splits `text` into at most `maxLines` lines that each measure at most `maxWidth`; the last ends in "…" when cut. */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
  maxLines: number,
): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let cut = false;
  const fits = (candidate: string) => measure(candidate) <= maxWidth;
  const push = (value: string) => {
    if (lines.length < maxLines) lines.push(value);
    else cut = true;
  };
  for (const word of words) {
    if (cut) break;
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line) push(line);
    line = "";
    // A word wider than a line is broken by characters.
    let rest = word;
    while (!fits(rest) && !cut) {
      const chars = [...rest];
      let take = chars.length - 1;
      while (take > 1 && !fits(chars.slice(0, take).join(""))) take -= 1;
      push(chars.slice(0, take).join(""));
      rest = chars.slice(take).join("");
    }
    if (!cut) line = rest;
  }
  if (!cut && line) push(line);
  if (cut && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last && !fits(`${last}…`)) last = [...last].slice(0, -1).join("");
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}
