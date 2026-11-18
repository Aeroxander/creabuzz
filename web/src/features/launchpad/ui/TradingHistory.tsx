/**
 * The weekly sale's earlier rounds on the Trading card: for each, the day it opened and either the lots traded with
 * their price a lot, or "No trade". The newest few show first; "Show older rounds" lists the next fixed block, one
 * bounded read at a time.
 *
 * Reads are best-effort and fail visibly: a block that could not be read says so with a way to try again, never an
 * empty list that reads as "no history" (Review-Proven Rule 1), and the blocks after a gap are not shown. Prices are
 * written in the market's own price token with the same words as the latest round's line, and the permanent price
 * label (`PriceSetterNote`) sits right under the list whenever it prints one.
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import { mergeHistory } from "../lib/round-history";
import type { QuoteUnits } from "../lib/trading-copy";
import {
  earlierPriceRow,
  earlierRoundsHeading,
  earlierShowsPrice,
  historyFailedLine,
  historyLoadingLine,
  showOlderLabel,
} from "../lib/trading-history-copy";
import { useRoundHistory } from "../use-secondary";
import { PriceSetterNote } from "./PriceSetterNote";
import { homeFocus, rescueFocus } from "./useFocusRescue";

/**
 * The list under the card, or nothing while the market has only one round (there is no earlier one to list). `latest`
 * is the market's latest round id, which the blocks are counted back from; `quote` is the price token's own units.
 */
export function TradingHistory({
  market,
  latest,
  quote,
}: {
  market: string;
  latest: bigint;
  quote: QuoteUnits;
}) {
  const headingId = useId();
  // How many blocks have been asked for, in this market; another market starts again with the first.
  const [asked, setAsked] = useState({ market, blocks: 1 });
  const requested = asked.market === market ? asked.blocks : 1;
  const blocks = useRoundHistory({ market, latest, blocks: requested });
  if (latest < 2n) return null;
  const { rounds, older, loaded } = mergeHistory(blocks);
  // The block being read, or the one that failed: the first that has not arrived.
  const next = blocks[loaded];
  const loading = next?.isFetching === true;
  const failed = next?.isError === true && !loading;
  const more = older !== null && older > 0n && next === undefined;
  return (
    <section
      aria-labelledby={headingId}
      className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3"
      data-testid="trading-history"
    >
      <h3
        className="text-sm font-semibold outline-none"
        id={headingId}
        tabIndex={-1}
        {...homeFocus("history")}
      >
        {earlierRoundsHeading()}
      </h3>
      {rounds.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="trading-history-list">
          {rounds.map((round) => {
            const row = earlierPriceRow(round, quote);
            return (
              <li
                className="flex flex-col text-sm"
                data-round-id={round.id.toString()}
                data-testid="trading-history-row"
                key={round.id.toString()}
              >
                <span className="text-xs text-muted-foreground">
                  {row.when}
                </span>
                <span>{row.outcome}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* Right under the list, and only where a price is printed. */}
      {earlierShowsPrice(rounds) ? <PriceSetterNote /> : null}
      {rounds.length === 0 && !failed ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="trading-history-loading"
          role="status"
        >
          {historyLoadingLine()}
        </p>
      ) : null}
      {failed ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <p
            className="text-destructive"
            data-testid="trading-history-failed"
            role="alert"
          >
            {historyFailedLine()}
          </p>
          <button
            className="underline"
            data-testid="trading-history-retry"
            {...rescueFocus("history")}
            onClick={() => void next?.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      {more || (loading && loaded > 0) ? (
        <div>
          {/* aria-disabled, not disabled: a disabled button drops the cursor while the block loads. */}
          <Button
            aria-disabled={loading}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            data-testid="trading-history-older"
            {...rescueFocus("history")}
            onClick={() => {
              if (loading) return;
              setAsked({ market, blocks: loaded + 1 });
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {showOlderLabel(loading)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
