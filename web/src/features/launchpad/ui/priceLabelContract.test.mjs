import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Counsel's condition for the weekly sale (brief Q14): a screen that prints a round's settled price must say, beside
 * it and for good, that one person can set that price. The screens are React components over wallet and network hooks
 * that a node test cannot mount, so the wiring is pinned in their source, as in `tradingCardContract.test.mjs`.
 *
 * The test finds every file in `web/src` that calls a function printing a weekly round's price, so a new screen that
 * prints one fails here until it carries the label and is added to the list below.
 */

const WEB_SRC = fileURLToPath(new URL("../../../", import.meta.url));

/** Every source file under web/src that is not a test, as `[relative path, text]`. */
function* sources(dir = WEB_SRC) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      yield [path.relative(WEB_SRC, full), readFileSync(full, "utf8")];
    }
  }
}

/** The functions that write a weekly round's price into a sentence or a table row. */
const PRICE_PRINTERS = [
  "roundLine", // the weekly listing: "Settled: N lots traded at P a lot"
  "clearingLine", // the older weekly rounds: "N Shares at P each changed hands"
  "lastTradeLine", // the older weekly rounds: "Last trade: ... at P each"
  "historyRow", // the older weekly rounds: the table of earlier rounds' prices
];

/** The screens that call a printer, and what each must render beside the call. */
const SCREENS = {
  "features/launchpad/ui/TradingCard.tsx": [
    {
      printer: "roundLine(",
      gate: /roundShowsPrice\(round\)\s*\?\s*<PriceSetterNote/,
    },
  ],
  "features/launchpad/ui/WeeklyRoundsCard.tsx": [
    {
      printer: "lastTradeLine(",
      gate: /historyShowsPrice\(history\)\s*\?\s*<PriceSetterNote/,
    },
    {
      printer: "historyRow(",
      gate: /historyShowsPrice\(history\)\s*\?\s*<PriceSetterNote/,
    },
    {
      printer: "clearingLine(",
      gate: /clearingShowsPrice\(round\)\s*\?\s*<PriceSetterNote/,
    },
  ],
};

const callers = (text) =>
  PRICE_PRINTERS.filter((name) => new RegExp(`\\b${name}\\(`).test(text));

test("every screen that prints a weekly round's price is on the list, so a new one fails here", () => {
  const found = [];
  for (const [file, text] of sources()) {
    // The modules that define the printers, and the label itself, are not screens.
    if (/\/lib\/(trading|rounds)-copy\.ts$/.test(file)) continue;
    if (callers(text).length > 0) found.push(file.split(path.sep).join("/"));
  }
  assert.deepEqual(found.sort(), Object.keys(SCREENS).sort());
});

test("each price is followed by the label, shown only when a price is shown", () => {
  for (const [file, sites] of Object.entries(SCREENS)) {
    const text = readFileSync(path.join(WEB_SRC, file), "utf8");
    // Every printer the file calls is a listed site: none is left unlabelled.
    assert.deepEqual(
      callers(text).sort(),
      sites.map((s) => s.printer.slice(0, -1)).sort(),
      `${file} calls a price printer that has no label rule`,
    );
    for (const { printer, gate } of sites) {
      const at = text.indexOf(printer, text.indexOf("export function"));
      assert.ok(at > 0, `${file} calls ${printer}`);
      assert.match(text, gate, `${file} gates the label for ${printer}`);
      // Beside the price: the label sits within the same few lines, not elsewhere on the screen.
      const gateAt = text.search(gate);
      assert.ok(
        Math.abs(gateAt - at) < 1500,
        `${file}: the label is not next to ${printer}`,
      );
      assert.match(
        text,
        /import \{ PriceSetterNote \} from "\.\/PriceSetterNote"/,
      );
    }
  }
});

test("the label is one plain paragraph from the shared sentence: visible, permanent, with one accessible name", () => {
  const note = readFileSync(
    path.join(WEB_SRC, "features/launchpad/ui/PriceSetterNote.tsx"),
    "utf8",
  );
  assert.match(note, /priceSetterLine\(\)/);
  assert.match(note, /from "\.\.\/lib\/trading-copy"/);
  assert.match(note, /<p\b/);
  assert.match(note, /data-testid="price-setter-note"/);
  // Not a tooltip, not a disclosure, not dismissible, not hidden, and not a second name for another element.
  assert.doesNotMatch(
    note,
    /title=|aria-label|aria-labelledby|aria-describedby|aria-hidden|sr-only|hidden|MoreInfo|Tooltip|onClick|useState|role=/,
  );
  // The wording lives only in trading-copy.ts.
  assert.doesNotMatch(note, /one person|same round/i);
  for (const [file, text] of sources()) {
    if (/trading-copy\.ts$|test\./.test(file)) continue;
    assert.doesNotMatch(
      text,
      /can set a round's price|more than one account/,
      `${file} repeats the sentence instead of calling priceSetterLine`,
    );
  }
});

test("the shared sentence is built in trading-copy.ts only", () => {
  const copy = readFileSync(
    path.join(WEB_SRC, "features/launchpad/lib/trading-copy.ts"),
    "utf8",
  );
  assert.equal(copy.match(/export function priceSetterLine/g)?.length, 1);
  assert.equal(copy.match(/export function roundShowsPrice/g)?.length, 1);
  // roundLine prints its price only where roundShowsPrice says so: the two cannot drift apart.
  assert.match(copy, /roundShowsPrice\(round\)\s*\?\s*`Settled:/);
});
