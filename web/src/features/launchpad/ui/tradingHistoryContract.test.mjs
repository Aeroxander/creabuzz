import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The Earlier rounds list is a React component over query hooks that a node test cannot mount, so the wiring that
 * matters is pinned in its source, as in `tradingCardContract.test.mjs`. What it reads and says is tested as plain
 * functions in `lib/round-history.test.mjs`; the permanent price label beside it is enforced by
 * `priceLabelContract.test.mjs`, which lists this file as a price-printing screen.
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the card shows the list only for a market with an earlier round and a price token that said its units", () => {
  const card = source("./TradingCard.tsx");
  assert.match(card, /import \{ TradingHistory \} from "\.\/TradingHistory"/);
  assert.match(
    card,
    /present && quote && data\.roundId !== null && data\.roundId > 1n \? \(\s*<TradingHistory\s+latest=\{data\.roundId\}\s+market=\{present\.market\}\s+quote=\{quote\}/,
  );
  // `quote` is the market's facts only when the token named its decimals and symbol: no price at a guessed scale.
  assert.match(
    card,
    /const quote = data\?\.facts\?\.quoteKnown \? data\.facts : null/,
  );
});

test("the rows and the label are made from the same rounds, so a printed price always has its label", () => {
  const list = source("./TradingHistory.tsx");
  assert.match(list, /rounds\.map\(\(round\) =>/);
  assert.match(list, /earlierPriceRow\(round, quote\)/);
  assert.match(
    list,
    /earlierShowsPrice\(rounds\) \? <PriceSetterNote \/> : null/,
  );
  // The label is not repeated per row, and its wording is not copied here.
  assert.equal(list.match(/<PriceSetterNote/g)?.length, 1);
  assert.doesNotMatch(list, /one person|more than one account/i);
});

test("a block that could not be read says so, with a retry, and is never shown as an empty list", () => {
  const list = source("./TradingHistory.tsx");
  assert.match(list, /historyFailedLine\(\)/);
  assert.match(list, /data-testid="trading-history-failed"/);
  assert.match(list, /role="alert"/);
  assert.match(list, /data-testid="trading-history-retry"/);
  assert.match(list, /next\?\.refetch\(\)/);
  // While nothing has arrived and nothing failed the list says it is loading, not that there is nothing.
  assert.match(list, /rounds\.length === 0 && !failed/);
  // The retry sits beside the alert, not inside it.
  assert.doesNotMatch(
    list,
    /<(\w+)\b[^>]*role="alert"[^>]*>(?:(?!<\/\1>)[\s\S])*<button\b/,
  );
  // The merged list stops at the first block that has not arrived: a gap is never skipped.
  assert.match(list, /mergeHistory\(blocks\)/);
});

test("older rounds are listed one fixed block at a time, only when asked for", () => {
  const list = source("./TradingHistory.tsx");
  assert.match(list, /data-testid="trading-history-older"/);
  assert.match(list, /blocks: loaded \+ 1/);
  // The button only exists while ids remain below the last block shown.
  assert.match(list, /older !== null && older > 0n/);
  const hook = source("../use-secondary.ts");
  assert.match(hook, /queryKey: historyQueryKey\(market, before\)/);
  assert.match(hook, /historyBlockBefore\(latest, i\)/);
  // Rounds below the latest are final: a step the wallet sends does not read them again.
  assert.match(hook, /staleTime: Number\.POSITIVE_INFINITY/);
  assert.doesNotMatch(hook, /SECONDARY_QUERY,\s*"secondary-history"/);
});

test("the list is reset for another market, and its reads are keyed by market", () => {
  const list = source("./TradingHistory.tsx");
  assert.match(list, /asked\.market === market \? asked\.blocks : 1/);
});
