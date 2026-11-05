/**
 * Trading, on a DAO's Funds tab (docs/v3-review/SECONDARY-LISTING-SPEC.md): one
 * market per DAO where holders offer existing Shares and buyers bid the
 * project's quote token, and a weekly round clears at one price over a grid the
 * round froze when it opened.
 *
 * The card is honest about the default. Trading is off until the DAO publishes
 * a listing, and the market exists from launch, so the three states are told
 * apart: no market for this DAO, a market with no listing, and a listing that is
 * on. Turning trading on is the DAO's own decision and is not offered here; the
 * card says so. A read that did not complete says it could not be read, never
 * that there is no market.
 *
 * Buying Shares here moves existing ones between people. It does not raise
 * money for the project and does not promise a next buyer.
 */

import { CalendarClock } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { MoreInfo } from "@/shared/ui/more-info";

import {
  encodeCancelBid,
  encodeCancelSell,
  encodeClaimQuote,
  encodeClaimShares,
  encodeOpenRound,
  encodeSettle,
  type RoundView,
  SECONDARY_EVERY,
  type WalletView,
} from "@creaton/core/launchpad/secondary.ts";

import {
  bidOrderLine,
  cardMode,
  claimDue,
  collectQuoteLabel,
  type FailureMark,
  factoryMissingLine,
  failureStands,
  listingDetailLine,
  nextRoundChip,
  roundLine,
  sellOrderLine,
  settleNoticeLine,
  shareUnits,
  staleReadLine,
  tokenUnreadableLine,
  tradingFailure,
  tradingLimits,
  tradingStateLine,
  unreadableLine,
  type WalletFunds,
} from "../lib/trading-copy";
import { placeOrder } from "../lib/trading-orders";
import { useChainSend } from "../use-chain-send";
import type { SecondaryMarketFacts } from "../lib/secondary-read";
import { SECONDARY_QUERY, useSecondary } from "../use-secondary";
import { FailureNote, GateNote, WalletStrip } from "./account-widgets";
import { QuoteTokenNote } from "./QuoteTokenNote";
import { TradingEarlier } from "./TradingEarlier";
import { BidForm, type Place, SellForm } from "./TradingOrderForms";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * The DAO's secondary market on a project's Funds tab, where this build names
 * the factory on the project's network. The connected account can open the
 * week's round, offer Shares, bid, take an order back, settle, and collect what
 * a finished round owes it.
 */
export function TradingCard({
  dao,
  chainId,
  saleCurrency,
}: {
  dao: string;
  /** The project's own network, as its record names it. */
  chainId: string | null;
  /** The project's recorded sale currency, so a price token that is not it is said plainly. */
  saleCurrency?: string | null;
}) {
  const network = chainId === null ? null : Number(chainId);
  const sender = useChainSend(
    network !== null && Number.isInteger(network) ? network : null,
    SECONDARY_QUERY,
  );
  const { factory, query } = useSecondary({
    chainId,
    dao,
    wallet: sender.wallet.address,
  });
  const data = query.data;
  const place: Place = (key, build) =>
    placeOrder(key, build, sender.sendBatch, sender.reportFailure);
  const read = data?.read ?? null;
  const blocked = sender.busy !== null || sender.gate !== null;
  // Why every button is off when the wallet is on another network. With no account at all the account strip below
  // already says what to do, so the note is only for a connected account that cannot act here.
  const gateId = useId();
  const gateNoteId =
    sender.gate !== null && sender.wallet.address ? gateId : undefined;
  const present = read?.kind === "present" ? read : null;
  const round = present?.round ?? null;
  // What prices are written in: the market's own quote token, as it names itself. Null when it would not say.
  const quote = data?.facts?.quoteKnown ? data.facts : null;
  const mode = cardMode({
    factoryKnown: factory !== null,
    data,
    failed: query.isError,
  });
  const over = round?.phase === "settled" || round?.phase === "void";
  const nextOpenAt = round === null ? 0 : round.opensAt + SECONDARY_EVERY;
  const canOpen =
    present?.listing.enabled === true &&
    (round === null || (over && (data?.now ?? 0) >= nextOpenAt));
  const waitingForNext =
    present?.listing.enabled === true && round !== null && over && !canOpen;
  // A failure note belongs to the read and the round it was raised on. It is recorded once the step has finished
  // (its own refresh included), so that refresh does not clear it; a later successful read, or a round that opened or
  // moved to its next phase, does.
  const roundKey =
    round === null || data?.roundId == null
      ? "none"
      : `${data.roundId}:${round.phase}`;
  const failureMark = useRef<FailureMark | null>(null);
  const { failure, busy, clearFailure } = sender;
  useEffect(() => {
    if (failure === null) {
      failureMark.current = null;
      return;
    }
    if (busy !== null) return;
    const now = { readAt: query.dataUpdatedAt, round: roundKey };
    const mark = failureMark.current;
    if (mark === null || mark.failure !== failure) {
      failureMark.current = { failure, ...now };
    } else if (!failureStands(mark, now)) {
      clearFailure();
    }
  }, [failure, busy, clearFailure, query.dataUpdatedAt, roundKey]);

  return (
    <Card className="p-4" data-testid="trading">
      <h2 className="text-base font-semibold">Trading</h2>
      {mode === "missing" ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="trading-state"
          role="status"
        >
          {factoryMissingLine()}
        </p>
      ) : mode === "unreadable" ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="trading-unreadable"
          role="status"
        >
          {unreadableLine()}{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : mode === "reading" || data === undefined ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          Reading…
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="trading-state">
            {data.tokenUnreadable && present?.listing.enabled
              ? tokenUnreadableLine()
              : tradingStateLine(data.read, data.now, quote)}
          </p>
          {query.isError ? (
            <p
              className="mt-1 text-sm text-muted-foreground"
              data-testid="trading-stale"
              role="status"
            >
              {staleReadLine(query.dataUpdatedAt)}{" "}
              <button
                className="underline"
                onClick={() => void query.refetch()}
                type="button"
              >
                Try again
              </button>
            </p>
          ) : null}
          <MoreInfo label="How trading works" testId="trading-how">
            Sellers offer Shares they already hold, in whole lots at a lowest
            price, and buyers bid for whole lots at a highest one, for three
            days. Then anyone settles the round at one price. Unsold Shares come
            back to their seller, and a buyer&apos;s money above the price comes
            back to them. If nobody settles within two days the round is void
            and everyone takes back what they put in. Trading moves existing
            Shares between people: it does not raise money for the project, and
            it does not promise a next buyer.
          </MoreInfo>
          <MoreInfo label="Before you trade" testId="trading-limits">
            <ul className="list-disc pl-4">
              {tradingLimits().map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </MoreInfo>
          {present?.listing.enabled && data.facts?.quoteKnown ? (
            <QuoteTokenNote
              address={data.facts.quoteToken}
              saleCurrency={saleCurrency}
              symbol={data.facts.quoteSymbol}
            />
          ) : null}
          {present?.listing.enabled && data.facts?.quoteKnown ? (
            <p className="mt-2 text-sm" data-testid="trading-listing">
              {listingDetailLine(
                present.listing,
                data.facts.lotSize,
                data.facts,
              )}
            </p>
          ) : null}
          <GateNote
            gate={
              gateNoteId === undefined || sender.gate === null
                ? { ok: true }
                : { ok: false, message: sender.gate }
            }
            id={gateNoteId}
            testId="trading-gate"
          />
          {canOpen && present ? (
            <Button
              aria-describedby={gateNoteId}
              className="mt-2"
              data-testid="trading-open"
              disabled={blocked}
              onClick={() =>
                void sender.send(
                  "trading-open",
                  present.market,
                  encodeOpenRound(present.market),
                )
              }
              size="sm"
              type="button"
            >
              {sender.busy === "trading-open"
                ? "Opening…"
                : "Open this week's round"}
            </Button>
          ) : waitingForNext ? (
            <p className="mt-2">
              <Chip icon={CalendarClock}>{nextRoundChip(nextOpenAt)}</Chip>
            </p>
          ) : null}
          {present && data.facts && round && data.roundId !== null ? (
            <TradingRound
              blocked={blocked}
              busy={sender.busy}
              facts={data.facts}
              funds={data.funds}
              gateNoteId={gateNoteId}
              listingEnabled={present.listing.enabled}
              market={present.market}
              tokenUnreadable={data.tokenUnreadable}
              me={sender.wallet.address}
              onPlace={place}
              onSend={sender.send}
              round={round}
              roundId={data.roundId}
              wallet={present.wallet}
            />
          ) : null}
          {present && data.facts && round && data.roundId !== null ? (
            <TradingEarlier
              blocked={blocked}
              busy={sender.busy}
              earlier={data.earlier}
              latest={data.roundId}
              facts={data.facts}
              gateNoteId={gateNoteId}
              market={present.market}
              me={sender.wallet.address}
              onSend={sender.send}
            />
          ) : null}
        </>
      )}
      <WalletStrip testIdPrefix="trading" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote
          failure={tradingFailure(sender.failure)}
          testId="trading-failure"
        />
      ) : null}
    </Card>
  );
}

/**
 * The latest round: where it stands, the wallet's own orders, and the steps the
 * round allows. Bidding takes orders; settling freezes the price; a settled or
 * void round pays out what each order is owed, including a seller's unsold lots:
 * settling returns none, so the Collect button for Shares shows for them too.
 */
function TradingRound({
  round,
  roundId,
  market,
  facts,
  funds,
  listingEnabled,
  tokenUnreadable,
  wallet,
  me,
  blocked,
  busy,
  gateNoteId,
  onPlace,
  onSend,
}: {
  round: RoundView;
  roundId: bigint;
  market: string;
  facts: SecondaryMarketFacts;
  /** What the connected wallet can offer and pay with; null with no wallet connected. */
  funds: WalletFunds | null;
  /** A closed listing takes no new offer or bid; settling, taking one back and collecting still work. */
  listingEnabled: boolean;
  /**
   * The price token would not say its units: no new offer or bid is taken, since no price can be written or checked,
   * while settling, taking an order back and collecting need none of them and stay.
   */
  tokenUnreadable: boolean;
  wallet: WalletView;
  me: string | null;
  blocked: boolean;
  busy: string | null;
  /** The note saying why the buttons are off (a wrong network), when there is one. */
  gateNoteId?: string;
  onPlace: Place;
  onSend: Send;
}) {
  const [form, setForm] = useState<"sell" | "bid" | null>(null);
  // Which order was just placed and has not yet been given the cursor: set when a form closes on success.
  const [landed, setLanded] = useState<"sell" | "bid" | null>(null);
  const formBase = useId();
  const sellFormId = `${formBase}-sell`;
  const bidFormId = `${formBase}-bid`;
  const sellTrigger = useRef<HTMLButtonElement>(null);
  const bidTrigger = useRef<HTMLButtonElement>(null);
  const sellLine = useRef<HTMLParagraphElement>(null);
  const bidLine = useRef<HTMLParagraphElement>(null);
  const bidding = round.phase === "bidding";
  const takingOrders = bidding && listingEnabled && !tokenUnreadable;
  const due = claimDue(round, wallet, facts.lotSize);
  const { sell, bid } = wallet;
  const settleNotice = settleNoticeLine(round, wallet);
  // A closed form hands the cursor to the order it placed, once the page shows that order: the form and its send
  // button are gone by then, and a screen reader would otherwise be left on nothing. If the cursor has moved on to
  // something else meanwhile it stays there.
  useEffect(() => {
    const line =
      landed === "sell" && sell
        ? sellLine.current
        : landed === "bid" && bid
          ? bidLine.current
          : null;
    if (landed === null || line === null) return;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      active === sellTrigger.current ||
      active === bidTrigger.current
    ) {
      line.focus();
    }
    setLanded(null);
  }, [landed, sell, bid]);
  const closeForm = (to: "sell" | "bid") => {
    setForm(null);
    (to === "sell" ? sellTrigger : bidTrigger).current?.focus();
  };
  const placed = (kind: "sell" | "bid") => {
    closeForm(kind);
    setLanded(kind);
  };
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3"
      data-testid="trading-round"
    >
      <p className="text-sm" data-testid="trading-round-status">
        {roundLine(round, facts)}
      </p>
      {settleNotice ? (
        <p
          className="text-sm"
          data-testid="trading-settle-notice"
          role="status"
        >
          {settleNotice}
        </p>
      ) : null}
      {/* Always in the page, so a new order is announced when it appears; it takes no room while empty. */}
      <div
        aria-live="polite"
        className={sell || bid ? "flex flex-col gap-2" : "sr-only"}
        data-testid="trading-orders"
        role="status"
      >
        {sell ? (
          <p
            className="text-sm outline-none"
            data-testid="trading-my-sell"
            ref={sellLine}
            tabIndex={-1}
          >
            {sellOrderLine(round, sell, facts)}
          </p>
        ) : null}
        {bid ? (
          <p
            className="text-sm outline-none"
            data-testid="trading-my-bid"
            ref={bidLine}
            tabIndex={-1}
          >
            {bidOrderLine(round, bid, facts)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {bidding && me && sell ? (
          <Button
            aria-describedby={gateNoteId}
            data-testid="trading-cancel-sell"
            disabled={blocked}
            onClick={() =>
              void onSend(
                "trading-cancel-sell",
                market,
                encodeCancelSell(market, roundId),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Take my Shares back
          </Button>
        ) : null}
        {bidding && me && bid && !bid.cancelled ? (
          <Button
            aria-describedby={gateNoteId}
            data-testid="trading-cancel-bid"
            disabled={blocked}
            onClick={() =>
              void onSend(
                "trading-cancel-bid",
                market,
                encodeCancelBid(market, roundId),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Take my bid back
          </Button>
        ) : null}
        {takingOrders && me && !sell ? (
          <Button
            aria-controls={form === "sell" ? sellFormId : undefined}
            aria-expanded={form === "sell"}
            data-testid="trading-sell"
            onClick={() => setForm(form === "sell" ? null : "sell")}
            ref={sellTrigger}
            size="sm"
            type="button"
            variant="outline"
          >
            Offer Shares
          </Button>
        ) : null}
        {takingOrders && me && !bid ? (
          <Button
            aria-controls={form === "bid" ? bidFormId : undefined}
            aria-expanded={form === "bid"}
            data-testid="trading-bid"
            onClick={() => setForm(form === "bid" ? null : "bid")}
            ref={bidTrigger}
            size="sm"
            type="button"
            variant="outline"
          >
            Bid for Shares
          </Button>
        ) : null}
        {round.phase === "settling" ? (
          <Button
            aria-describedby={gateNoteId}
            data-testid="trading-settle"
            disabled={blocked}
            onClick={() =>
              void onSend(
                "trading-settle",
                market,
                encodeSettle(market, roundId),
              )
            }
            size="sm"
            type="button"
          >
            {busy === "trading-settle" ? "Settling…" : "Settle the round"}
          </Button>
        ) : null}
        {me && (due.shares > 0n || due.quote > 0n) ? (
          <div className="flex flex-wrap gap-2" data-testid="trading-claim">
            {due.shares > 0n ? (
              <Button
                aria-describedby={gateNoteId}
                data-testid="trading-claim-shares"
                disabled={blocked}
                onClick={() =>
                  void onSend(
                    "trading-claim-shares",
                    market,
                    encodeClaimShares(market, roundId, me),
                  )
                }
                size="sm"
                type="button"
              >
                {busy === "trading-claim-shares"
                  ? "Collecting…"
                  : `Collect ${shareUnits(due.shares)} Shares`}
              </Button>
            ) : null}
            {due.quote > 0n ? (
              <Button
                aria-describedby={gateNoteId}
                data-testid="trading-claim-quote"
                disabled={blocked}
                onClick={() =>
                  void onSend(
                    "trading-claim-quote",
                    market,
                    encodeClaimQuote(market, roundId, me),
                  )
                }
                size="sm"
                type="button"
              >
                {busy === "trading-claim-quote"
                  ? "Collecting…"
                  : collectQuoteLabel(due.quote, facts)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {takingOrders && me && funds && form === "sell" ? (
        <SellForm
          blocked={blocked}
          busy={busy}
          domId={sellFormId}
          facts={facts}
          funds={funds}
          gateNoteId={gateNoteId}
          id={roundId}
          market={market}
          onCancel={() => closeForm("sell")}
          onDone={() => placed("sell")}
          onPlace={onPlace}
          round={round}
        />
      ) : null}
      {takingOrders && me && funds && form === "bid" ? (
        <BidForm
          blocked={blocked}
          busy={busy}
          domId={bidFormId}
          facts={facts}
          funds={funds}
          gateNoteId={gateNoteId}
          id={roundId}
          market={market}
          onCancel={() => closeForm("bid")}
          onDone={() => placed("bid")}
          onPlace={onPlace}
          round={round}
        />
      ) : null}
    </div>
  );
}
