/**
 * The words the Trading card's earlier-rounds list says: each round's day and what it came to, the heading, and what a
 * failed or slow read says. Split from `trading-copy.ts`, which may not grow, and written with the same `money` and
 * `lots` as the latest round's line so the two read side by side. Pure, so `round-history.test.mjs` pins every line.
 */

import type { HistoryRound } from "./round-history.ts";
import { lots, money, type QuoteUnits } from "./trading-copy.ts";

/** The list's heading. */
export function earlierRoundsHeading(): string {
  return "Earlier rounds";
}

/**
 * When a round opened, with the zone it is written in, so a person in another zone is never left guessing. `timeZone`
 * is for tests; the page uses the viewer's own.
 */
export function roundOpenedLine(seconds: number, timeZone?: string): string {
  const when = new Date(seconds * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
  return `Opened ${when}`;
}

/**
 * One row of the list: the day, and either the lots traded and their price a lot or "No trade". A round that never
 * settled and one where nothing crossed both traded nothing, and neither names a price.
 */
export function earlierPriceRow(
  round: Pick<HistoryRound, "opensAt" | "outcome">,
  quote: QuoteUnits,
  timeZone?: string,
): { when: string; outcome: string } {
  const { outcome } = round;
  return {
    when: roundOpenedLine(round.opensAt, timeZone),
    outcome:
      outcome.kind === "traded"
        ? `${lots(outcome.lots)} traded at ${money(outcome.price, quote)} a lot`
        : "No trade",
  };
}

/** Whether any row of the list names a price, which is when the permanent label must sit beside the list. */
export function earlierShowsPrice(
  rounds: readonly Pick<HistoryRound, "outcome">[],
): boolean {
  return rounds.some((r) => r.outcome.kind === "traded");
}

/** Said when a block of earlier rounds could not be read, so it is not mistaken for a market with no history. */
export function historyFailedLine(): string {
  return "Could not load earlier rounds. Try again.";
}

/** Said while the first block is being read. */
export function historyLoadingLine(): string {
  return "Loading earlier rounds…";
}

/** The button that lists the next block of older rounds. */
export function showOlderLabel(loading: boolean): string {
  return loading ? "Loading…" : "Show older rounds";
}
