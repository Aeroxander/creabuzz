/**
 * The picture that goes with a shared project: a 1200 by 630 image with the project's mark and name, its goal, and one
 * line of fact from its signed record. It never shows a price, returns, a market value or Shares as value: only what the
 * record says (promises kept, weeks in a row, work accepted).
 *
 * Four variants: the project just started, a promise was kept, a piece of work was accepted by someone else, a piece of
 * work was done and checked by the founder alone. The last two are never worded alike: only work someone else checked
 * is "accepted".
 *
 * The words and the layout are pure and run under `node --test` (`cardFact`, `wrapLines`, `cardAlt`, `cardFileName`). The
 * drawing (`drawShareCard`) takes any object shaped like a 2D canvas context, so a test can record what it draws.
 * Only `renderShareCard` touches the page; it needs a browser.
 */

import { acceptedWords, doneAloneWords } from "./share.ts";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export type ShareCardVariant = "started" | "kept" | "accepted" | "done";

export interface ShareCardInput {
  variant: ShareCardVariant;
  name: string;
  /** The goal in the founder's words; empty when none was set. */
  goal: string;
  /** The product name, from `APP_NAME`. */
  app: string;
  /** The same figures `shareWords` takes. */
  streak: number | null;
  kept: number | null;
  answered: number | null;
  /** For "accepted": how many pieces of work were accepted, and the title of the one just accepted, when known. */
  accepted?: number | null;
  /** For "done": how many pieces of work only the founder checked. Kept apart from `accepted`. */
  doneAlone?: number | null;
  /** For "started": when the first update is due, as "Mon, Nov 23". */
  firstDue?: string | null;
  workTitle?: string | null;
}

/** A streak is only stated once the project has answered at least this many promises. */
const STREAK_NEEDS_ANSWERED = 2;
/** The streak that is worth a line, as on the scorecard. */
const STREAK_FROM = 2;
const GOAL_LINES = 3;
const NAME_LINES = 2;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

/** "3 of 4 promises kept", plus "4 weeks in a row" only once two or more promises are answered. Null with none. */
function keptFact(input: ShareCardInput): string | null {
  const { kept, answered, streak } = input;
  if (kept === null || !answered) return null;
  const parts = [
    `${kept} of ${answered} ${answered === 1 ? "promise" : "promises"} kept`,
  ];
  if (
    streak !== null &&
    streak >= STREAK_FROM &&
    answered >= STREAK_NEEDS_ANSWERED
  )
    parts.push(`${streak} weeks in a row`);
  return parts.join(", ");
}

/** What a brand-new project says when its first update's date is not known. */
export const STARTED_FACT = "Just started. Follow along as it gets built.";

/** What a brand-new project says: it just started, and when its first update is due. */
function startedFact(firstDue: string | null | undefined): string {
  return firstDue
    ? `Just started. First update due ${firstDue}.`
    : STARTED_FACT;
}
/** What a project says when its record holds nothing for the card asked for: it claims nothing, not even that it is new. */
export const FOLLOW_FACT = "Follow along as it gets built.";

/**
 * The one fact line. Every variant falls back to a line that claims nothing when the record does not hold what the
 * variant needs, so a card never states more than the record shows.
 */
export function cardFact(input: ShareCardInput): string {
  if (input.variant === "accepted") {
    return acceptedWords(input) ?? keptFact(input) ?? FOLLOW_FACT;
  }
  if (input.variant === "done")
    return doneAloneWords(input) ?? keptFact(input) ?? FOLLOW_FACT;
  if (input.variant === "kept") return keptFact(input) ?? FOLLOW_FACT;
  return startedFact(input.firstDue);
}

/**
 * Which pictures a project's record can honestly offer, best first: "kept" once a promise is answered, "accepted" once
 * someone else accepted work, "done" once the founder checked work alone. With none of them, "started" only for a project that is brand new (`fresh`: nothing posted yet); an
 * older one gets the "kept" picture, which then says only to follow along.
 */
export function cardVariantsFor(record: {
  answered: number | null;
  accepted: number | null;
  /** Pieces of work only the founder checked (never added to `accepted`). Optional: older callers leave it out. */
  doneAlone?: number | null;
  fresh: boolean;
}): ShareCardVariant[] {
  const out: ShareCardVariant[] = [];
  if (record.answered) out.push("kept");
  if (record.accepted) out.push("accepted");
  if (record.doneAlone) out.push("done");
  if (out.length > 0) return out;
  return [record.fresh ? "started" : "kept"];
}

/** The card's alt text and the line a screen reader gets. */
export function cardAlt(input: ShareCardInput): string {
  const goal = clip(input.goal, 160);
  return `${input.name} on ${input.app}.${goal ? ` Goal: ${goal}.` : ""} ${cardFact(input)}`;
}

/** A file name for the downloaded picture: letters, digits and hyphens only. */
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

/** Words that must never be on a card: a price, returns, a market value. A test checks every string the card draws. */
export const FORBIDDEN_ON_CARD =
  /\$|€|£|\bUSDC\b|\bETH\b|\bprice\b|\breturns?\b|\bearn|\bprofit|\bmarket cap|\bvalue\b|\bdividend|\bpayout|\bAPY\b|\binvest/i;

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
      let take = [...rest].length - 1;
      while (take > 1 && !fits([...rest].slice(0, take).join(""))) take -= 1;
      push([...rest].slice(0, take).join(""));
      rest = [...rest].slice(take).join("");
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

/** The part of a 2D canvas context the drawing uses. */
export interface CardContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  fill(): void;
  save(): void;
  restore(): void;
  clip(): void;
  drawImage(
    image: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = "#f4f6f5";
const MUTED = "#a9b4af";
const BACKGROUND = "#101513";
const ACCENT = "hsl(153, 59%, 47%)";
const PAD = 72;
const MARK = 128;
const WIDTH_INSIDE = CARD_WIDTH - PAD * 2;

function roundedSquare(
  ctx: CardContext,
  x: number,
  y: number,
  size: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + size, y, x + size, y + size, radius);
  ctx.arcTo(x + size, y + size, x, y + size, radius);
  ctx.arcTo(x, y + size, x, y, radius);
  ctx.arcTo(x, y, x + size, y, radius);
  ctx.closePath();
}

/**
 * Draws the card. `mark` is the project's picture when it loaded; without it the mark is the name's first letter on a
 * soft square, as on the page. Every string drawn comes from `cardFact`, the name, the goal and the product name.
 */
export function drawShareCard(
  ctx: CardContext,
  input: ShareCardInput,
  mark: CanvasImageSource | null,
): void {
  const measureAt = (font: string) => (line: string) => {
    ctx.font = font;
    return ctx.measureText(line).width;
  };

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, 16, CARD_HEIGHT);

  // The mark.
  const markX = PAD;
  const markY = PAD;
  ctx.save();
  roundedSquare(ctx, markX, markY, MARK, 28);
  if (mark) {
    ctx.clip();
    ctx.drawImage(mark, markX, markY, MARK, MARK);
  } else {
    ctx.fillStyle = "hsla(153, 59%, 47%, 0.2)";
    ctx.fill();
  }
  ctx.restore();
  if (!mark) {
    ctx.fillStyle = ACCENT;
    ctx.font = `800 72px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      [...input.name.trim()][0]?.toUpperCase() || "?",
      markX + MARK / 2,
      markY + MARK / 2 + 4,
    );
  }

  // The name, beside the mark, up to two lines.
  const nameFont = `800 60px ${FONT}`;
  const nameX = markX + MARK + 36;
  const nameLines = wrapLines(
    input.name,
    CARD_WIDTH - PAD - nameX,
    measureAt(nameFont),
    NAME_LINES,
  );
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = nameFont;
  const nameTop = markY + MARK / 2 - ((nameLines.length - 1) * 66) / 2 + 20;
  nameLines.forEach((line, i) => {
    ctx.fillText(line, nameX, nameTop + i * 66);
  });

  // The goal, up to three lines.
  const goal = input.goal.trim();
  const goalFont = `500 44px ${FONT}`;
  if (goal) {
    ctx.fillStyle = INK;
    ctx.font = goalFont;
    wrapLines(goal, WIDTH_INSIDE, measureAt(goalFont), GOAL_LINES).forEach(
      (line, i) => {
        ctx.fillText(line, PAD, 292 + i * 62);
      },
    );
  }

  // The one fact line, from the record, and the product name under it.
  const factFont = `700 46px ${FONT}`;
  const fact = wrapLines(cardFact(input), WIDTH_INSIDE, measureAt(factFont), 1);
  ctx.fillStyle = ACCENT;
  ctx.font = factFont;
  ctx.fillText(fact[0] ?? "", PAD, 510);
  ctx.fillStyle = MUTED;
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText(`${input.app} · public scorecard`, PAD, 570);
}

/**
 * The picture as a PNG, or null when this browser cannot make one. `mark` is the project's picture when it could be
 * loaded without tainting the canvas.
 */
export async function renderShareCard(
  input: ShareCardInput,
  mark: CanvasImageSource | null,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawShareCard(ctx, input, mark);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}

/** Loads the project's picture for the card, or null when it will not load (or the server forbids reading it). */
export function loadMarkImage(
  url: string | null | undefined,
  timeoutMs = 4000,
): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    const done = (value: HTMLImageElement | null) => {
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), timeoutMs);
    // Without this the canvas would be tainted and could not be saved: a picture that forbids it is left out.
    image.crossOrigin = "anonymous";
    image.onload = () => done(image);
    image.onerror = () => done(null);
    image.src = url;
  });
}
