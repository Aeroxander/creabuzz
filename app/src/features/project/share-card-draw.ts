/**
 * Draws the share picture (1,200 by 630) on any object shaped like a 2D canvas context, so a test can record every string
 * drawn. Only `renderShareCard` touches the page. The words come from `share-card.ts`; nothing is drawn that is not in
 * `CardContent`, and no picture from the network is loaded (the project's initial stands for its mark), so no outside
 * address is asked for and the canvas is never tainted.
 */
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  type CardContent,
  wrapLines,
} from "./share-card";

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
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = "#f4f6f5";
const MUTED = "#a9b4af";
const BACKGROUND = "#101513";
const ACCENT = "#43e296";
const PAD = 72;
const MARK = 128;
const INSIDE = CARD_WIDTH - PAD * 2;

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

/** Draws the card; `app` is the product name (from the brand constant), drawn under the banner. */
export function drawShareCard(
  ctx: CardContext,
  card: CardContent,
  app: string,
): void {
  const measureAt = (font: string) => (line: string) => {
    ctx.font = font;
    return ctx.measureText(line).width;
  };
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, 16, CARD_HEIGHT);

  // The mark: the name's first letter on a soft square.
  roundedSquare(ctx, PAD, PAD, MARK, 28);
  ctx.fillStyle = "rgba(67, 226, 150, 0.2)";
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.font = `800 72px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    [...card.name][0]?.toUpperCase() || "?",
    PAD + MARK / 2,
    PAD + MARK / 2 + 4,
  );

  // The name beside the mark, two lines at most.
  const nameFont = `800 60px ${FONT}`;
  const nameX = PAD + MARK + 36;
  const nameLines = wrapLines(
    card.name,
    CARD_WIDTH - PAD - nameX,
    measureAt(nameFont),
    2,
  );
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = nameFont;
  const top = PAD + MARK / 2 - ((nameLines.length - 1) * 66) / 2 + 20;
  nameLines.forEach((line, i) => {
    ctx.fillText(line, nameX, top + i * 66);
  });

  // The founder's line, three lines at most.
  const pitchFont = `500 40px ${FONT}`;
  if (card.pitch) {
    ctx.fillStyle = INK;
    ctx.font = pitchFont;
    wrapLines(card.pitch, INSIDE, measureAt(pitchFont), 3).forEach(
      (line, i) => {
        ctx.fillText(line, PAD, 282 + i * 56);
      },
    );
  }

  // At most two facts.
  const factFont = `700 36px ${FONT}`;
  ctx.fillStyle = ACCENT;
  ctx.font = factFont;
  card.facts.forEach((fact, i) => {
    ctx.fillText(
      wrapLines(fact, INSIDE, measureAt(factFont), 1)[0] ?? "",
      PAD,
      460 + i * 46,
    );
  });

  // The banner, the play-money line and the product name.
  const bannerFont = `600 26px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.font = bannerFont;
  ctx.fillText(
    wrapLines(card.banner, INSIDE, measureAt(bannerFont), 1)[0] ?? "",
    PAD,
    CARD_HEIGHT - 84,
  );
  if (card.playMoney) ctx.fillText(card.playMoney, PAD, CARD_HEIGHT - 50);
  ctx.textAlign = "right";
  ctx.fillText(app, CARD_WIDTH - PAD, CARD_HEIGHT - 50);
}

/** The picture as a PNG, or null when this browser cannot make one. */
export async function renderShareCard(
  card: CardContent,
  app: string,
): Promise<Blob | null> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    drawShareCard(ctx, card, app);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
  } catch {
    return null;
  }
}
