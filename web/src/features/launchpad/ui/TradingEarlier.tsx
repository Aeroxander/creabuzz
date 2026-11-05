/**
 * What earlier rounds still owe the connected wallet, on the Trading card.
 *
 * A round is settled or void within five days, but anyone may open the next one a
 * week after the last, and nothing pays a round's orders out on its own: a
 * settled round still owes the buyer's Shares and refund, the seller's
 * proceeds and the seller's unsold lots (settling hands none back), and a void
 * round owes both sides everything. A claim never expires,
 * so each such round keeps its own row here, collected with that round's own id,
 * after the card has moved on to the newest round (Review-Proven Rule 6: the
 * newest round must not hide the only way to collect an older one).
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import {
  encodeClaimQuote,
  encodeClaimShares,
  type EarlierRoundsRead,
} from "@creaton/core/launchpad/secondary.ts";

import {
  checkOlderLabel,
  earlierAllCheckedLine,
  earlierDues,
  earlierLimitLine,
  earlierRoundLine,
  collectQuoteLabel,
  olderFailedLine,
  shareUnits,
} from "../lib/trading-copy";
import {
  mergeOlderRounds,
  type SecondaryMarketFacts,
} from "../lib/secondary-read";
import { useOlderRounds } from "../use-secondary";

/**
 * One row per earlier round that still owes `me` something, and a note when older
 * rounds were not checked, with a button that checks the next fixed block of them
 * (so a round owed from long ago is reachable here, one bounded read at a time).
 * Shows nothing when there is nothing to say.
 */
export function TradingEarlier({
  earlier,
  latest,
  facts,
  market,
  me,
  blocked,
  busy,
  onSend,
}: {
  earlier: EarlierRoundsRead;
  /** The market's latest round id, which the older blocks are counted back from. */
  latest: bigint;
  facts: SecondaryMarketFacts;
  market: string;
  /** The connected wallet, or null: with none there is nothing to collect for. */
  me: string | null;
  blocked: boolean;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const headingId = useId();
  // How many older blocks have been asked for, for this wallet in this market; another wallet starts again.
  const scope = `${market}:${me ?? ""}`;
  const [asked, setAsked] = useState({ scope, blocks: 0 });
  const requested = asked.scope === scope ? asked.blocks : 0;
  const blocks = useOlderRounds({
    market,
    wallet: me,
    latest,
    unchecked: earlier.unchecked,
    blocks: requested,
  });
  if (!me) return null;
  const older = mergeOlderRounds(earlier.unchecked, blocks);
  // How many blocks have arrived in order; the next one is the one being read, or the one that failed.
  const firstMissing = blocks.findIndex((b) => !b.data);
  const settled = firstMissing === -1 ? blocks.length : firstMissing;
  const next = blocks[settled];
  const checking = next?.isFetching === true;
  const failed = next?.isError === true && !checking;
  const owed = earlierDues([...earlier.rounds, ...older.rounds], facts.lotSize);
  // Every earlier round the page has looked at: the ones below the latest, less the ones still unchecked.
  const checkedCount = Number(latest - 1n - older.unchecked);
  const limit = earlierLimitLine(checkedCount, older.unchecked);
  const allChecked = settled > 0 && older.unchecked === 0n;
  if (owed.length === 0 && limit === null && !allChecked) return null;
  const checkOlder = () => {
    if (failed) void next?.refetch();
    else setAsked({ scope, blocks: settled + 1 });
  };
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3"
      data-testid="trading-earlier-block"
    >
      {owed.length > 0 ? (
        <section
          aria-labelledby={headingId}
          className="flex flex-col gap-2"
          data-testid="trading-earlier"
        >
          <h3 className="text-sm font-semibold" id={headingId}>
            Collect from an earlier round
          </h3>
          {owed.map(({ earlier: row, due }) => (
            <EarlierRow
              blocked={blocked}
              busy={busy}
              due={due}
              facts={facts}
              id={row.id}
              key={row.id.toString()}
              market={market}
              me={me}
              onSend={onSend}
              round={row.round}
            />
          ))}
        </section>
      ) : null}
      {limit !== null ? (
        <div className="flex flex-col items-start gap-2">
          <p
            className="text-sm text-muted-foreground"
            data-testid="trading-earlier-limit"
            role="status"
          >
            {limit}
          </p>
          <Button
            data-testid="trading-earlier-check"
            disabled={checking}
            onClick={checkOlder}
            size="sm"
            type="button"
            variant="outline"
          >
            {checkOlderLabel(checking)}
          </Button>
        </div>
      ) : allChecked ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="trading-earlier-all-checked"
          role="status"
        >
          {earlierAllCheckedLine()}
        </p>
      ) : null}
      {failed ? (
        <p
          className="text-sm text-destructive"
          data-testid="trading-earlier-failed"
          role="alert"
        >
          {olderFailedLine()}
        </p>
      ) : null}
    </div>
  );
}

function EarlierRow({
  id,
  round,
  due,
  facts,
  market,
  me,
  blocked,
  busy,
  onSend,
}: {
  id: bigint;
  round: EarlierRoundsRead["rounds"][number]["round"];
  due: { shares: bigint; quote: bigint };
  facts: SecondaryMarketFacts;
  market: string;
  me: string;
  blocked: boolean;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const lineId = useId();
  const sharesKey = `trading-earlier-claim-shares-${id}`;
  const quoteKey = `trading-earlier-claim-quote-${id}`;
  return (
    <div
      className="flex flex-col gap-2"
      data-round-id={id.toString()}
      data-testid="trading-earlier-round"
    >
      <p className="text-sm" id={lineId}>
        {earlierRoundLine(round)}
      </p>
      <div className="flex flex-wrap gap-2">
        {due.shares > 0n ? (
          <Button
            aria-describedby={lineId}
            data-testid="trading-earlier-claim-shares"
            disabled={blocked}
            onClick={() =>
              void onSend(sharesKey, market, encodeClaimShares(market, id, me))
            }
            size="sm"
            type="button"
          >
            {busy === sharesKey
              ? "Collecting…"
              : `Collect ${shareUnits(due.shares)} Shares`}
          </Button>
        ) : null}
        {due.quote > 0n ? (
          <Button
            aria-describedby={lineId}
            data-testid="trading-earlier-claim-quote"
            disabled={blocked}
            onClick={() =>
              void onSend(quoteKey, market, encodeClaimQuote(market, id, me))
            }
            size="sm"
            type="button"
          >
            {busy === quoteKey
              ? "Collecting…"
              : collectQuoteLabel(due.quote, facts)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
