import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The trading card and its listing form are React components over wallet and network hooks that a node test cannot
 * mount, so the wiring that matters is pinned in their source, as in `ideaSaleStepsContract.test.mjs`. The rules they
 * follow are tested as plain functions: `cardMode`, `refreshEveryMs`, `readSecondaryView`.
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the card is told what to show by cardMode, so a failed refresh cannot replace what was read", () => {
  const card = source("./TradingCard.tsx");
  // The mode is cardMode's answer as it stands: nothing else (an error flag, say) is allowed to override it.
  assert.match(card, /const mode = cardMode\(\{/);
  // The old first branch: any error, or an unreadable read, replaced the whole card with "Try again".
  assert.doesNotMatch(
    card,
    /query\.isError \|\| read\?\.kind === "unreadable"/,
  );
  assert.match(card, /mode === "unreadable"/);
  assert.match(card, /staleReadLine\(/);
  // The note is in the card's ready branch, ahead of the round, with its own way to try again.
  const ready = card.slice(card.indexOf('mode === "unreadable"'));
  assert.ok(
    ready.indexOf("trading-stale") < ready.indexOf("<TradingRound"),
    "the stale note sits above the round",
  );
  assert.match(card, /data-testid="trading-stale"/);
});

test("the card shows the Collect, Settle and Cancel buttons whether or not the price token could be read", () => {
  const card = source("./TradingCard.tsx");
  // Only a new offer or bid needs the token's units.
  assert.match(
    card,
    /takingOrders = bidding && listingEnabled && !tokenUnreadable/,
  );
  assert.match(card, /collectQuoteLabel\(due\.quote, facts\)/);
  assert.doesNotMatch(card, /Collect \$\{money\(due\.quote, facts\)\}/);
  const earlier = source("./TradingEarlier.tsx");
  assert.match(earlier, /collectQuoteLabel\(due\.quote, facts\)/);
  assert.doesNotMatch(earlier, /Collect \$\{money\(due\.quote, facts\)\}/);
  // The round is no longer withheld when the token is unreadable.
  assert.doesNotMatch(
    card,
    /tokenUnreadable \? tokenUnreadableLine\(\) : unreadableLine\(\)/,
  );
});

test("the query keeps polling after a failure, through the one reader that throws", () => {
  const hook = source("../use-secondary.ts");
  assert.match(
    hook,
    /refetchInterval: \(q\) => pollSecondary\(q, calm\.current\)/,
  );
  assert.match(hook, /readSecondaryView\(/);
  // The hook does not catch: a failed read must reach React Query as a throw.
  assert.doesNotMatch(hook, /catch/);
});

test("the listing form asks for the market alone: a wallet read failing must not take its off switch", () => {
  const form = source("./TradingListingForm.tsx");
  const call = form.slice(
    form.indexOf("useSecondary({"),
    form.indexOf("});", form.indexOf("useSecondary({")),
  );
  assert.match(call, /wallet: null/);
  assert.doesNotMatch(call, /ctx\.wallet/);
  // Price boxes need the token's scale; the off switch does not.
  assert.match(form, /!view\?\.tokenUnreadable/);
});

test("the earlier-rounds block offers to check the next block of older rounds, and the card hands it the latest round id", () => {
  const card = source("./TradingCard.tsx");
  assert.match(card, /latest=\{data\.roundId\}/);
  const earlier = source("./TradingEarlier.tsx");
  // The button is the way back to a round older than the first window (Review-Proven Rule 6).
  assert.match(earlier, /data-testid="trading-earlier-check"/);
  assert.match(earlier, /useOlderRounds\(/);
  assert.match(earlier, /mergeOlderRounds\(earlier\.unchecked, blocks\)/);
  // A block that failed is said so and retried, never shown as checked.
  assert.match(earlier, /olderFailedLine\(\)/);
  assert.match(earlier, /next\?\.refetch\(\)/);
  const hook = source("../use-secondary.ts");
  // Every block's key names the wallet, the latest round and its own bound, and a sent step invalidates it.
  assert.match(hook, /\.\.\.SECONDARY_QUERY,\s*"older"/);
  assert.match(hook, /latest\.toString\(\)/);
  assert.match(hook, /before\.toString\(\)/);
});

test("the card renders nothing where the build offers no trading, and the project page needs no second check", () => {
  const card = source("./TradingCard.tsx");
  assert.match(
    card,
    /import \{ tradingOffered \} from "\.\.\/lib\/trading-offered"/,
  );
  assert.match(card, /if \(!tradingOffered\(\)\) return null;/);
  // The live round's own terms and the listing switch reach the copy.
  assert.match(card, /shownTerms\(present\.listing, round\)/);
  assert.match(card, /roundLine\(round, facts, listingEnabled\)/);
});

test("the Try again buttons sit beside the status text, not inside any status element", () => {
  const card = source("./TradingCard.tsx");
  // A button inside a role=status element, of any tag, is read as part of the announcement and is not a separate stop.
  const inStatus =
    /<(\w+)\b[^>]*role="status"[^>]*>(?:(?!<\/\1>)[\s\S])*<button\b/;
  assert.doesNotMatch(card, inStatus);
  // The text is still a status, and each retry button is still there.
  assert.match(card, /data-testid="trading-unreadable"/);
  assert.match(card, /data-testid="trading-stale"/);
  assert.equal(card.match(/Try again/g)?.length, 2);
});

/** What sits between the previous tag's closing `>` and the tag opening at `open`, once comments are removed. */
const gapBefore = (card, open) => {
  const before = card.slice(0, open).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  return before.slice(before.lastIndexOf(">") + 1);
};

/** The opening of the element that carries `testId`, and the text of its opening tag. */
const elementWith = (card, testId) => {
  const at = card.indexOf(`data-testid="${testId}"`);
  assert.ok(at > 0, `${testId} is rendered`);
  const open = Math.max(
    card.lastIndexOf("<p", at),
    card.lastIndexOf("<div", at),
  );
  return { open, tag: card.slice(open, card.indexOf(">", at)) };
};

test("the settle notice lives in a region that is always mounted, so its arrival is announced", () => {
  const card = source("./TradingCard.tsx");
  const { open, tag } = elementWith(card, "trading-settle-notice");
  // Always mounted: only blank space (and comments) sits between the previous tag and this one, so no `&&`, `||`,
  // `??`, `? (` or `? <p` can be gating it.
  assert.equal(
    gapBefore(card, open).trim(),
    "",
    "the notice is not mounted only with its text",
  );
  assert.match(tag, /aria-live="polite"/);
  assert.match(tag, /role="status"/);
  // Empty, it takes no room.
  assert.match(card, /settleNotice \? "text-sm" : "sr-only"/);
});

test("the stale-read note lives in a region that is always mounted, so a failed refresh is announced", () => {
  const card = source("./TradingCard.tsx");
  const { open, tag } = elementWith(card, "trading-stale");
  assert.match(tag, /^<p\b/);
  assert.match(tag, /aria-live="polite"/);
  assert.match(tag, /role="status"/);
  // The note and the wrapper that holds it beside its button are both in the page whatever the query is doing.
  assert.equal(
    gapBefore(card, open).trim(),
    "",
    "the note is not mounted only with its text",
  );
  const wrapper = card.lastIndexOf("<div", open);
  assert.equal(
    gapBefore(card, wrapper).trim(),
    "",
    "the note's wrapper is not mounted only on a failure",
  );
  // Empty, it takes no room; the text and the button come only with the failure.
  assert.match(tag, /query\.isError \? "[^"]*" : "sr-only"/);
  const rest = card.slice(open, card.indexOf("</div>", open));
  assert.match(rest, /\{query\.isError \? staleReadLine\(/);
  assert.match(rest, /\{query\.isError \? \(\s*<>[\s\S]*?<button\b/);
});
