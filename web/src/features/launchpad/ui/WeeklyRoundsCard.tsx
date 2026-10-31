import { CalendarClock, Scale } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { MoreInfo } from "@/shared/ui/more-info";
import { defaultChainPreset } from "../chain-config";
import { encodeActivateExitExchange } from "../lib/matched-exit";
import {
  clearingLine,
  roundStatusLine,
  roundsStateLine,
  shares as sharesText,
  usdc,
} from "../lib/rounds-copy";
import {
  encodeCancelBid,
  encodeCancelSell,
  encodeClaimAndLeave,
  encodeClaimRound,
  encodeOpenRound,
  encodeSettleRound,
  orderOutcome,
  type RoundView,
  SETTLE_WINDOW,
} from "../lib/weekly-rounds";
import { useChainSend } from "../use-chain-send";
import {
  type RoundsWallet,
  useWeeklyRounds,
  WEEKLY_ROUNDS_QUERY,
} from "../use-weekly-rounds";
import { FailureNote, WalletStrip } from "./account-widgets";
import { RoundClaims } from "./RoundClaims";
import { BidForm, OfferForm } from "./RoundOrderForms";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Weekly rounds (D131), on a contributor project's Funds tab: once a week, members who want out are matched with people
 * who want in, at one price never below what leaving pays, so the treasury keeps its money. Shown where this build names
 * the rounds contract and the DAO's Shares are locked; until the DAO has voted rounds on and they were switched on 30
 * days later, it says where things stand.
 */
export function WeeklyRoundsCard({ dao }: { dao: string }) {
  const sender = useChainSend(
    defaultChainPreset().chainId,
    WEEKLY_ROUNDS_QUERY,
  );
  const { contract, query } = useWeeklyRounds(dao, sender.wallet.address);
  const data = query.data;
  if (!contract || data === null) return null;
  if (data?.state.phase === "unlocked") return null;
  const blocked = sender.busy !== null || sender.gate !== null;
  const round = data?.rounds?.round ?? null;
  const on = data?.state.phase === "on";
  const canOpen =
    on &&
    data !== undefined &&
    data.rounds !== null &&
    data.now >= data.rounds.nextOpensAt &&
    (round === null || round.phase === "settled" || round.phase === "void");

  return (
    <Card className="p-4" data-testid="rounds">
      <h2 className="text-base font-semibold">Weekly rounds</h2>
      {query.isError ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          The network did not answer, so the rounds can&apos;t be shown.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : data === undefined ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          Reading…
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="rounds-state">
            {roundsStateLine(data.state.phase, data.state.opensAt)}
          </p>
          <MoreInfo label="How a round works" testId="rounds-how">
            Sellers offer Shares with a lowest price and buyers bid with a
            highest one, for three days. Then anyone settles it at one price:
            the highest at which bids still take everything offered. The price
            never goes below what leaving the project pays. A fifth of a
            seller&apos;s gain above that goes to the treasury. Anyone can still
            leave at any time, and if nobody settles within two days, everyone
            takes back what they put in.
          </MoreInfo>
          {data.state.phase === "ready" ? (
            <Button
              className="mt-2"
              data-testid="rounds-switch-on"
              disabled={blocked}
              onClick={() =>
                void sender.send(
                  "rounds-switch-on",
                  data.shares,
                  encodeActivateExitExchange(),
                )
              }
              size="sm"
              type="button"
            >
              {sender.busy === "rounds-switch-on"
                ? "Switching on…"
                : "Switch on weekly rounds"}
            </Button>
          ) : null}
          {canOpen ? (
            <Button
              className="mt-2"
              data-testid="rounds-open"
              disabled={blocked}
              onClick={() =>
                void sender.send(
                  "rounds-open",
                  data.contract,
                  encodeOpenRound(dao),
                )
              }
              size="sm"
              type="button"
            >
              {sender.busy === "rounds-open"
                ? "Opening…"
                : "Open this week's round"}
            </Button>
          ) : on &&
            round &&
            (round.phase === "settled" || round.phase === "void") &&
            data.rounds &&
            data.now < data.rounds.nextOpensAt ? (
            <p className="mt-2">
              <Chip icon={CalendarClock}>
                Next round from {when(data.rounds.nextOpensAt)}
              </Chip>
            </p>
          ) : null}
          {round ? (
            <RoundPanel
              blocked={blocked}
              busy={sender.busy}
              contract={data.contract}
              currency={data.usdc}
              me={sender.wallet.address}
              onSend={sender.send}
              round={round}
              shares={data.shares}
              side={data.wallet}
            />
          ) : null}
          <RoundClaims
            blocked={blocked}
            busy={sender.busy}
            claims={data.claims}
            contract={data.contract}
            me={sender.wallet.address}
            onSend={sender.send}
          />
        </>
      )}
      <WalletStrip testIdPrefix="rounds" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="rounds-failure" />
      ) : null}
    </Card>
  );
}

/**
 * One round: its status, prices, your orders and the steps it allows. A funding round (D133) sells the project's new
 * units: there is nothing to offer or leave from, only bids and collecting.
 */
export function RoundPanel({
  round,
  contract,
  currency,
  shares,
  side,
  me,
  blocked,
  busy,
  onSend,
}: {
  round: RoundView;
  contract: string;
  currency: string;
  shares: string;
  side: RoundsWallet | null;
  me: string | null;
  blocked: boolean;
  busy: string | null;
  onSend: Send;
}) {
  const [form, setForm] = useState<"offer" | "bid" | null>(null);
  const { sell, bid } = round.mine;
  const holders = !round.funding;
  const what = holders ? "Shares" : "new units";
  const bidding = round.phase === "bidding";
  const over = round.phase === "settled" || round.phase === "void";
  const unclaimed =
    (sell !== null && !sell.claimed) || (bid !== null && !bid.claimed);
  // What each of your orders gets once settled; a void round sells and buys nothing.
  const settled = round.phase === "settled";
  const sold = sell && settled ? orderOutcome(round, "sell", sell) : null;
  const bought = bid && settled ? orderOutcome(round, "bid", bid) : null;
  // Shares you would collect: what did not sell, and what you bought.
  const unitsBack =
    (sell ? sell.amount - (sold?.units ?? 0n) : 0n) + (bought?.units ?? 0n);

  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3"
      data-testid="rounds-round"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Round {round.id.toString()}</span>
        <Chip icon={Scale}>
          Floor {usdc(round.floor)} a {holders ? "Share" : "unit"}
        </Chip>
      </div>
      <p className="text-sm" data-testid="rounds-round-status">
        {roundStatusLine(round, round.closesAt + SETTLE_WINDOW)}
      </p>
      <p className="text-sm font-medium" data-testid="rounds-clearing">
        {clearingLine(round)}
      </p>
      {round.rows.length > 0 ? (
        <table className="text-sm" data-testid="rounds-rows">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pr-4 font-medium">
                Price a {holders ? "Share" : "unit"}
              </th>
              <th className="pr-4 font-medium">Offered at or below</th>
              <th className="font-medium">Wanted at or above</th>
            </tr>
          </thead>
          <tbody>
            {round.rows.map((row) => (
              <tr
                className={
                  row.step === round.clearing.step ? "font-semibold" : ""
                }
                data-testid="rounds-row"
                key={row.step}
              >
                <td className="pr-4">{usdc(row.price)}</td>
                <td className="pr-4">{sharesText(row.offered)}</td>
                <td>{sharesText(row.wanted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {sell ? (
        <OrderLine
          testId="rounds-my-sell"
          text={`You offer ${sharesText(sell.amount)} Shares at ${usdc(round.floor + BigInt(sell.step) * round.step)} or more.${over && sold ? ` Sold: ${sharesText(sold.units)} Shares, for ${usdc(sold.money)} after the cut.` : ""}${sell.claimed ? " Collected." : ""}`}
        />
      ) : null}
      {bid ? (
        <OrderLine
          testId="rounds-my-bid"
          text={`You bid for ${sharesText(bid.amount)} ${what} at up to ${usdc(round.floor + BigInt(bid.step) * round.step)}.${over && bought ? ` Bought: ${sharesText(bought.units)} ${what}, for ${usdc(bought.money)}.` : ""}${bid.claimed ? " Collected." : ""}`}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {holders && bidding && sell ? (
          <>
            <Button
              data-testid="rounds-cancel-sell"
              disabled={blocked}
              onClick={() =>
                void onSend(
                  "rounds-cancel-sell",
                  contract,
                  encodeCancelSell(round.id),
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Take my Shares back
            </Button>
            <Button
              data-testid="rounds-leave-now"
              disabled={blocked}
              onClick={() =>
                void onSend(
                  "rounds-leave-now",
                  contract,
                  encodeCancelSell(round.id, [currency]),
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Take them back and leave
            </Button>
          </>
        ) : null}
        {bidding && bid ? (
          <Button
            data-testid="rounds-cancel-bid"
            disabled={blocked}
            onClick={() =>
              void onSend(
                "rounds-cancel-bid",
                contract,
                encodeCancelBid(round.id),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Take my bid back
          </Button>
        ) : null}
        {holders &&
        bidding &&
        side &&
        !sell &&
        side.free > 0n &&
        form !== "offer" ? (
          <Button
            data-testid="rounds-offer-open"
            onClick={() => setForm("offer")}
            size="sm"
            type="button"
            variant="outline"
          >
            Offer Shares
          </Button>
        ) : null}
        {bidding && side && !bid && form !== "bid" ? (
          <Button
            data-testid="rounds-bid-open"
            onClick={() => setForm("bid")}
            size="sm"
            type="button"
            variant="outline"
          >
            {holders ? "Bid for Shares" : "Bid for new units"}
          </Button>
        ) : null}
        {round.phase === "settling" ? (
          <Button
            data-testid="rounds-settle"
            disabled={blocked}
            onClick={() =>
              void onSend(
                "rounds-settle",
                contract,
                encodeSettleRound(round.id, round.clearing.step),
              )
            }
            size="sm"
            type="button"
          >
            {busy === "rounds-settle" ? "Settling…" : "Settle the round"}
          </Button>
        ) : null}
        {over && unclaimed && me ? (
          <>
            <Button
              data-testid="rounds-collect"
              disabled={blocked}
              onClick={() =>
                void onSend(
                  "rounds-collect",
                  contract,
                  encodeClaimRound(round.id, me),
                )
              }
              size="sm"
              type="button"
            >
              {busy === "rounds-collect" ? "Collecting…" : "Collect"}
            </Button>
            {holders && unitsBack > 0n ? (
              <Button
                data-testid="rounds-collect-leave"
                disabled={blocked}
                onClick={() =>
                  void onSend(
                    "rounds-collect-leave",
                    contract,
                    encodeClaimAndLeave(round.id, [currency]),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Collect, and leave with the Shares
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {bidding && side && form === "offer" ? (
        <OfferForm
          blocked={blocked}
          busy={busy}
          contract={contract}
          grid={round}
          id={round.id}
          onDone={() => setForm(null)}
          onSend={onSend}
          shares={shares}
          side={side}
        />
      ) : null}
      {bidding && side && form === "bid" ? (
        <BidForm
          blocked={blocked}
          busy={busy}
          contract={contract}
          currency={currency}
          funding={!holders}
          grid={round}
          id={round.id}
          onDone={() => setForm(null)}
          onSend={onSend}
          side={side}
        />
      ) : null}
    </div>
  );
}

function OrderLine({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="text-sm" data-testid={testId}>
      {text}
    </p>
  );
}
