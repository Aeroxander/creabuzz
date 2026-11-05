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
import { useId, useState } from "react";

import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { Input } from "@/shared/ui/input";
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
  bidHolds,
  bidOrderLine,
  bidPlan,
  cardMode,
  claimDue,
  collectQuoteLabel,
  factoryMissingLine,
  listingDetailLine,
  lotPriceLine,
  lots as lotsLabel,
  money,
  nextRoundChip,
  quoteHeldLine,
  roundLine,
  sellHolds,
  sellOrderLine,
  sellPlan,
  sellRoomLine,
  settleNoticeLine,
  shareUnits,
  staleReadLine,
  tokenUnreadableLine,
  tradingFailureLine,
  tradingStateLine,
  unreadableLine,
  type WalletFunds,
} from "../lib/trading-copy";
import { bidCalls, placeOrder, sellCalls } from "../lib/trading-orders";
import { useChainSend } from "../use-chain-send";
import type { SecondaryMarketFacts } from "../lib/secondary-read";
import { SECONDARY_QUERY, useSecondary } from "../use-secondary";
import { FailureNote, WalletStrip } from "./account-widgets";
import { TradingEarlier } from "./TradingEarlier";

type Send = (key: string, to: string, data: string) => Promise<boolean>;
/** Put one order on the network as one step: every call built first, then sent together (`lib/trading-orders.ts`). */
type Place = (key: string, build: () => SenderCall[]) => Promise<boolean>;

/**
 * The DAO's secondary market on a project's Funds tab, where this build names
 * the factory on the project's network. The connected account can open the
 * week's round, offer Shares, bid, take an order back, settle, and collect what
 * a finished round owes it.
 */
export function TradingCard({
  dao,
  chainId,
}: {
  dao: string;
  /** The project's own network, as its record names it. */
  chainId: string | null;
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
          {present?.listing.enabled && data.facts?.quoteKnown ? (
            <p className="mt-2 text-sm" data-testid="trading-listing">
              {listingDetailLine(
                present.listing,
                data.facts.lotSize,
                data.facts,
              )}
            </p>
          ) : null}
          {canOpen && present ? (
            <Button
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
          message={tradingFailureLine(sender.failure)}
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
  onPlace: Place;
  onSend: Send;
}) {
  const [form, setForm] = useState<"sell" | "bid" | null>(null);
  const bidding = round.phase === "bidding";
  const takingOrders = bidding && listingEnabled && !tokenUnreadable;
  const due = claimDue(round, wallet, facts.lotSize);
  const { sell, bid } = wallet;
  const settleNotice = settleNoticeLine(round, wallet);
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
      {sell ? (
        <p className="text-sm" data-testid="trading-my-sell">
          {sellOrderLine(round, sell, facts)}
        </p>
      ) : null}
      {bid ? (
        <p className="text-sm" data-testid="trading-my-bid">
          {bidOrderLine(round, bid, facts)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {bidding && me && sell ? (
          <Button
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
        {takingOrders && me && !sell && form !== "sell" ? (
          <Button
            data-testid="trading-sell"
            onClick={() => setForm("sell")}
            size="sm"
            type="button"
            variant="outline"
          >
            Offer Shares
          </Button>
        ) : null}
        {takingOrders && me && !bid && form !== "bid" ? (
          <Button
            data-testid="trading-bid"
            onClick={() => setForm("bid")}
            size="sm"
            type="button"
            variant="outline"
          >
            Bid for Shares
          </Button>
        ) : null}
        {round.phase === "settling" ? (
          <Button
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
          facts={facts}
          funds={funds}
          id={roundId}
          market={market}
          onDone={() => setForm(null)}
          onPlace={onPlace}
          round={round}
        />
      ) : null}
      {takingOrders && me && funds && form === "bid" ? (
        <BidForm
          blocked={blocked}
          busy={busy}
          facts={facts}
          funds={funds}
          id={roundId}
          market={market}
          onDone={() => setForm(null)}
          onPlace={onPlace}
          round={round}
        />
      ) : null}
    </div>
  );
}

/**
 * The offer form: whole lots at a lowest price, held to what the wallet can
 * offer now. The Shares are approved to the market and the offer escrows exactly
 * those lots, as one step.
 */
function SellForm({
  round,
  market,
  facts,
  funds,
  id,
  blocked,
  busy,
  onPlace,
  onDone,
}: {
  round: RoundView;
  market: string;
  facts: SecondaryMarketFacts;
  funds: WalletFunds;
  id: bigint;
  blocked: boolean;
  busy: string | null;
  onPlace: Place;
  onDone: () => void;
}) {
  const formId = useId();
  const [lotsInput, setLotsInput] = useState("");
  const [priceText, setPriceText] = useState("");
  const plan =
    lotsInput.trim() && priceText.trim()
      ? sellPlan(round, lotsInput, priceText, facts, funds)
      : null;
  const go = async () => {
    if (!plan || "problem" in plan) return;
    const placed = await onPlace("trading-sell", () =>
      sellCalls({
        market,
        roundId: id,
        lots: plan.lots,
        level: plan.level,
        facts,
      }),
    );
    if (placed) onDone();
  };
  return (
    <div className="mt-2 grid gap-2" data-testid="trading-sell-form">
      <p
        className="text-sm text-muted-foreground"
        data-testid="trading-sell-room"
      >
        {sellRoomLine(funds, facts.lotSize)}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id={`${formId}-lots`}
          inputMode="numeric"
          label="Lots to offer"
          onChange={setLotsInput}
          placeholder="2"
          testId="trading-sell-lots"
          value={lotsInput}
        />
        <Field
          id={`${formId}-price`}
          label={`Lowest price a lot (${facts.quoteSymbol})`}
          onChange={setPriceText}
          placeholder="1.02"
          testId="trading-sell-price"
          value={priceText}
        />
      </div>
      <PlanLine
        line={
          plan && !("problem" in plan)
            ? `This holds ${lotsLabel(plan.lots)} (${shareUnits(sellHolds(plan.lots, facts.lotSize))} Shares) until the round settles. ${lotPriceLine(round, plan.level, facts)}.`
            : null
        }
        problem={plan && "problem" in plan ? plan.problem : null}
        testId="trading-sell-plan"
      />
      <Button
        className="justify-self-start"
        data-testid="trading-sell-submit"
        disabled={blocked || !plan || "problem" in plan}
        onClick={() => void go()}
        size="sm"
        type="button"
      >
        {busy === "trading-sell" ? "Offering…" : "Offer them"}
      </Button>
    </div>
  );
}

/**
 * The bid form: whole lots at a highest price, held to the money the wallet
 * holds. The money the bid holds is approved to the market (unless it already
 * is) and escrowed by the bid, as one step.
 */
function BidForm({
  round,
  market,
  facts,
  funds,
  id,
  blocked,
  busy,
  onPlace,
  onDone,
}: {
  round: RoundView;
  market: string;
  facts: SecondaryMarketFacts;
  funds: WalletFunds;
  id: bigint;
  blocked: boolean;
  busy: string | null;
  onPlace: Place;
  onDone: () => void;
}) {
  const formId = useId();
  const [lotsInput, setLotsInput] = useState("");
  const [priceText, setPriceText] = useState("");
  const plan =
    lotsInput.trim() && priceText.trim()
      ? bidPlan(round, lotsInput, priceText, facts, funds)
      : null;
  const go = async () => {
    if (!plan || "problem" in plan) return;
    const placed = await onPlace("trading-bid", () =>
      bidCalls({
        market,
        roundId: id,
        round,
        lots: plan.lots,
        level: plan.level,
        allowance: funds.quoteAllowance,
        facts,
      }),
    );
    if (placed) onDone();
  };
  return (
    <div className="mt-2 grid gap-2" data-testid="trading-bid-form">
      <p
        className="text-sm text-muted-foreground"
        data-testid="trading-bid-room"
      >
        {quoteHeldLine(funds, facts)}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id={`${formId}-lots`}
          inputMode="numeric"
          label="Lots to buy"
          onChange={setLotsInput}
          placeholder="2"
          testId="trading-bid-lots"
          value={lotsInput}
        />
        <Field
          id={`${formId}-price`}
          label={`Highest price a lot (${facts.quoteSymbol})`}
          onChange={setPriceText}
          placeholder="1.05"
          testId="trading-bid-price"
          value={priceText}
        />
      </div>
      <PlanLine
        line={
          plan && !("problem" in plan)
            ? `This bid holds ${money(bidHolds(round, plan.lots, plan.level), facts)} until the round settles. You pay the round's price, never more than yours, and get back the rest. ${lotPriceLine(round, plan.level, facts)}.`
            : null
        }
        problem={plan && "problem" in plan ? plan.problem : null}
        testId="trading-bid-plan"
      />
      <Button
        className="justify-self-start"
        data-testid="trading-bid-submit"
        disabled={blocked || !plan || "problem" in plan}
        onClick={() => void go()}
        size="sm"
        type="button"
      >
        {busy === "trading-bid" ? "Bidding…" : "Place the bid"}
      </Button>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  testId,
  inputMode = "decimal",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  testId: string;
  inputMode?: "decimal" | "numeric";
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        className="w-40"
        data-testid={testId}
        id={id}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </div>
  );
}

function PlanLine({
  line,
  problem,
  testId,
}: {
  line: string | null;
  problem: string | null;
  testId: string;
}) {
  if (problem) {
    return (
      <p
        className="text-sm text-red-700 dark:text-red-300"
        data-testid={`${testId}-problem`}
        role="alert"
      >
        {problem}
      </p>
    );
  }
  return line ? (
    <p className="text-sm text-muted-foreground" data-testid={testId}>
      {line}
    </p>
  ) : null;
}
