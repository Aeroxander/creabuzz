/**
 * What the share picture says (plan section 7.2): the project's name, its line, at most two facts, the fixed banner and the
 * play-money line, and nothing else. **No amount, no count of people, no gain figure, no price**: the words are chosen
 * here and every string the drawing puts on the picture comes from this file, so a test that records them can scan them.
 * Pure: the drawing is `share-card-draw.ts`.
 */
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { type ProjectNumbers, freshnessOf } from "../money/numbers";
import { doorShutWords, TAKE_OUT_BANNER } from "../pot/pot-words";
import { unitCount, WEEK_SECS } from "./unit-words";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const CARD_PLAY_MONEY = "Play money on a test network.";

/** Words and signs that must never be on the card: an amount, a price, a gain, a count of people. A test scans every string drawn. */
export const FORBIDDEN_ON_CARD =
  /[$€£¥%]|\b(price|prices|gain|gains|return|returns|profit|worth|value|earn\w*|dividends?|payouts?|apy|invest\w*|yield)\b|\b\d[\d,.]*\s*(people|persons?|backers?|holders?|investors?|accounts?)\b/i;

/** More words a founder's own line must not carry onto the card: they speak of making money, which the card never does. */
const FOUNDER_WORDS_LEFT_OFF =
  /\b(money|cash|income|wealth|rich|doubl\w*|triple\w*|interest|passive)\b/i;
/** Money words and multiples the picture never carries: "dollars", "ten times", "a million". */
const AMOUNT_WORDS =
  /\b(dollars?|bucks?|usd|eur|euros?|cents?|btc|eth|sats?|pounds?|gbp|yen|times|\w+fold|hundreds?|thousands?|millions?|billions?|trillions?|dozens?)\b/i;

/** What a name that cannot go on the card is called instead. */
export const CARD_NAME_FALLBACK = "A new project";

/**
 * Whether founder text carries what the card must not: an amount, a price, a gain, a multiple ("10x", "ten times"), a currency
 * sign or word, or a word about making money. It is an allow list in spirit: the text is first folded to its plain form (so a
 * full-width "＄500" is "$500"), and a line is kept only when none of this is found in it. `smallNumbers` lets a name keep a
 * short plain number ("Studio 54"), never one that is a figure ("100x", "5M", "300%", "1,000").
 */
function carriesFigure(flat: string, smallNumbers: boolean): boolean {
  if (
    FORBIDDEN_ON_CARD.test(flat) ||
    FOUNDER_WORDS_LEFT_OFF.test(flat) ||
    AMOUNT_WORDS.test(flat) ||
    /\p{Sc}/u.test(flat)
  )
    return true;
  const rest = smallNumbers
    ? flat.replace(/(?<![\d.,])\d{1,2}(?![\d.,]|\s*[kmb]\b|\s*[x×%])/giu, "")
    : flat;
  return /\p{N}/u.test(rest);
}

/** Founder text folded to plain single-spaced characters. */
function plain(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * The founder's line, or nothing: a founder's own words can carry what the card must not (an amount, a gain, a multiple, a
 * currency, a number at all), so such a line is left off and the card is only its name.
 */
export function pitchForCard(pitch: string): string {
  const flat = plain(pitch);
  return flat === "" || carriesFigure(flat, false) ? "" : flat;
}

/** The project's name for the card: the founder's own, unless it carries what the card must not (then a plain word). */
function nameForCard(name: string): string {
  const flat = plain(name);
  return flat === "" || carriesFigure(flat, true) ? CARD_NAME_FALLBACK : flat;
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
 * record is not too old to say) and the run of check-ins (from one unit), which a record past a day does not say either.
 */
export function cardContent(
  input: { name: string; pitch: string },
  numbers: ProjectNumbers | null,
  now: number,
): CardContent {
  const facts: string[] = [];
  const fresh = numbers !== null && freshnessOf(numbers, now).level !== "stale";
  if (numbers && fresh && doorShutWords(numbers, now) === null)
    facts.push("Open to back");
  // A record past a day does not say how many weeks: an old run is never put on a picture that has no "as of".
  const runs = fresh ? (numbers?.streaks?.updates.weeks ?? 0) : 0;
  if (numbers && runs >= 1)
    facts.push(
      numbers.unit === WEEK_SECS
        ? `${unitCount(runs, numbers.unit)} of check-ins in a row`
        : `Check-ins in a row for ${unitCount(runs, numbers.unit)}`,
    );
  return {
    name: nameForCard(input.name),
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
