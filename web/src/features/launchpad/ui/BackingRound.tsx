/**
 * The opening round of a project's backing: a fair auction for about a week, then one price for everyone. This card shows
 * where the round stands (its minimum, what it has raised, how long is left), takes a bid with a highest price on the
 * auction's own grid, lets anyone settle it once it has ended, and, for a bidder, takes the money back (a round that did
 * not reach its minimum) or collects the tokens and exchanges them for units (one that did).
 *
 * The bid is the same step the sale pages send: the approval to Permit2, Permit2's approval of the auction, then the bid
 * (`lib/bid-tx.ts`, the one composer behind both the wallet and the passkey path). Taking money back and collecting
 * are the existing "My bids" panel, given the round's own token so its amounts are in the right units.
 */

import {
  formatAmount,
  formatRoundPrice,
  parseAmount,
  type PoolView,
  roundStage,
  snapRoundLimit,
} from "@creaton/core/launchpad/backing.ts";
import { type FormEvent, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { documentedBlockTimeSeconds, getRpcEndpoint } from "../chain";
import {
  bidPlanWithDefaultHint,
  buildBidCalls,
  validateBid,
} from "../lib/bid-tx";
import { money, spanWords, unitsPhrase } from "../lib/backing-copy";
import { redeemCalls, settleRoundCalls } from "../lib/backing-orders";
import type { Launch } from "../models";
import { MyBidsPanel } from "./MyBidsPanel";
import type { Place } from "./TradingOrderForms";

interface RoundProps {
  launch: Launch;
  view: PoolView;
  place: Place;
  /** The acting account, or null with none. */
  me: string | null;
  blocked: boolean;
  busy: string | null;
  gateNoteId?: string;
}

const BID_DEADLINE_SECONDS = 3_600;

function endsLine(view: PoolView, chainId: number): string {
  const left = view.snapshot.round.endBlock - view.block;
  if (left <= 0) return "The round has ended.";
  const seconds = left * documentedBlockTimeSeconds(String(chainId));
  return `The round ends in about ${spanWords(seconds)}.`;
}

/** The round while it waits: its facts, the bid form, and the settle button once it has ended. */
export function RoundCard(props: RoundProps) {
  const { launch, view, me, place, blocked, busy, gateNoteId } = props;
  const chainId = Number(launch.record.chainId);
  const { snapshot, quote } = view;
  const round = snapshot.round;
  const stage = roundStage(round, view.block);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="backing-round">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="glass rounded-2xl border p-3">
          <dt className="text-xs text-muted-foreground">
            Needs to raise at least
          </dt>
          <dd
            className="text-base font-bold"
            data-testid="backing-round-minimum"
          >
            {money(round.minimumRaise, quote)}
          </dd>
        </div>
        <div className="glass rounded-2xl border p-3">
          <dt className="text-xs text-muted-foreground">Raised so far</dt>
          <dd
            className="text-base font-bold"
            data-testid="backing-round-raised"
          >
            {money(round.raised, quote)}
          </dd>
        </div>
        <div className="glass col-span-2 rounded-2xl border p-3 sm:col-span-1">
          <dt className="text-xs text-muted-foreground">Round</dt>
          <dd className="text-base font-bold" data-testid="backing-round-ends">
            {endsLine(view, chainId)}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        If the round raises less than its minimum, everyone takes their money
        back and backing does not open.
      </p>
      {stage === "ended" ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm" data-testid="backing-round-ended">
            The round has ended. Anyone can settle it: that works out whether it
            reached its minimum, and opens backing or closes it.
          </p>
          <div>
            <Button
              aria-describedby={gateNoteId}
              className="max-sm:h-11"
              data-testid="backing-settle-round"
              disabled={blocked}
              onClick={() =>
                void place("backing-settle-round", () =>
                  settleRoundCalls(view.pool),
                )
              }
              size="sm"
              type="button"
            >
              {busy === "backing-settle-round"
                ? "Settling…"
                : "Settle the round"}
            </Button>
          </div>
        </div>
      ) : me ? (
        <div>
          <Button
            aria-controls="backing-bid-form"
            aria-expanded={open}
            className="max-sm:h-11"
            data-testid="backing-bid"
            onClick={() => setOpen((was) => !was)}
            size="sm"
            type="button"
          >
            Bid in the round
          </Button>
        </div>
      ) : null}
      {stage === "bidding" && open && me ? (
        <BidForm
          {...props}
          me={me}
          onDone={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      ) : null}
      {me ? <BidsDisclosure {...props} me={me} /> : null}
    </div>
  );
}

/** The wallet's bids behind one line, so a round with no bid of its own is not a page of someone else's tools. */
export function BidsDisclosure({
  open,
  ...props
}: RoundProps & { me: string; open?: boolean }) {
  return (
    <details
      className="rounded-lg border p-3"
      data-testid="backing-bids-disclosure"
      open={open}
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium sm:min-h-0">
        Your bids in the opening round
      </summary>
      <div className="mt-2">
        <RoundBids {...props} />
      </div>
    </details>
  );
}

/** A failed round: the bidders' money comes back from the auction. */
export function FailedRound(props: RoundProps) {
  return props.me ? (
    <div className="flex flex-col gap-2" data-testid="backing-round-failed">
      <BidsDisclosure {...props} me={props.me} open />
    </div>
  ) : null;
}

/** The wallet's bids in the round: take money back, collect what was bought. The existing panel, in the round's words. */
function RoundBids({ launch, view }: RoundProps & { me: string }) {
  const auction = view.snapshot.round.auction;
  return (
    <MyBidsPanel
      currency={{
        kind: "custom",
        symbol: view.quote.symbol ?? "",
        decimals: view.quote.decimals,
        value: view.quote.address,
      }}
      record={{ ...launch.record, auction, currency: view.quote.address }}
      rpcEndpoint={getRpcEndpoint()}
      words={{
        title: "Your bids",
        intro:
          "Take back the money that did not buy anything, then collect the round tokens you bought once the round has been settled. Round tokens are then exchanged for backing units.",
      }}
    />
  );
}

/** After the round opened backing: exchange the round tokens a bidder holds for units. */
export function RedeemRow({
  view,
  place,
  blocked,
  busy,
  gateNoteId,
}: Pick<RoundProps, "view" | "place" | "blocked" | "busy" | "gateNoteId">) {
  const tokens = view.snapshot.round.holderClaimTokens;
  if (view.snapshot.round.state !== "live" || tokens === 0n) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="backing-redeem">
      <p className="text-sm">
        You hold {formatAmount(tokens, 18)} round tokens from the opening round.
        Exchange them for backing units to sell them or leave at a milestone.
      </p>
      <div>
        <Button
          aria-describedby={gateNoteId}
          className="max-sm:h-11"
          data-testid="backing-redeem-button"
          disabled={blocked}
          onClick={() =>
            void place("backing-redeem", () => redeemCalls(view.pool, tokens))
          }
          size="sm"
          type="button"
        >
          {busy === "backing-redeem"
            ? "Exchanging…"
            : `Exchange for ${unitsPhrase(tokens)}`}
        </Button>
      </div>
    </div>
  );
}

function BidForm({
  view,
  place,
  me,
  blocked,
  busy,
  gateNoteId,
  onDone,
  onCancel,
}: RoundProps & { me: string; onDone: () => void; onCancel: () => void }) {
  const base = useId();
  const field = useRef<HTMLInputElement>(null);
  const priceField = useRef<HTMLInputElement>(null);
  const { quote: token, snapshot } = view;
  const round = snapshot.round;
  const grid = view.round;
  // Prefilled with twice the higher of the round's price and its floor, on the grid: a bid above the price it will pay.
  const starting = (() => {
    if (!grid) return "";
    const base =
      round.clearingPriceX96 > grid.floorPriceX96
        ? round.clearingPriceX96
        : grid.floorPriceX96;
    return formatRoundPrice(base * 2n, token.decimals);
  })();
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState(starting);
  const [tried, setTried] = useState(false);
  const budget =
    amount.trim() === "" ? null : parseAmount(amount, token.decimals);
  const limit = grid
    ? snapRoundLimit(price, token.decimals, grid.tickSpacingX96)
    : null;

  const problem = ((): string | null => {
    if (!grid)
      return "The round's price steps could not be read, so a bid cannot be made right now.";
    if (budget === null || budget <= 0n)
      return "Enter how much to bid, as a number above zero.";
    if (view.walletMoney && budget > view.walletMoney.balance)
      return `You hold ${money(view.walletMoney.balance, token)}, which is less than that.`;
    if (limit === null)
      return "Enter the highest price you will pay for one unit, as a number above zero.";
    const issues = validateBid(
      bidPlanWithDefaultHint(
        { maxPriceQ96: limit, amount: budget, owner: me, hookData: "0x" },
        grid.floorPriceX96,
      ),
      {
        tickSpacingQ96: grid.tickSpacingX96,
        clearingPriceQ96: round.clearingPriceX96,
        supply: round.supply,
      },
    );
    const first = issues.find((i) => i.severity === "error");
    if (!first) return null;
    return first.field === "maxPrice"
      ? `Your highest price has to be above the round's price now (${formatRoundPrice(round.clearingPriceX96, token.decimals)}). Raise it.`
      : "Enter how much to bid, as a number above zero.";
  })();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem !== null || budget === null || limit === null || !grid) {
      (budget === null || budget <= 0n ? field : priceField).current?.focus();
      return;
    }
    const placed = await place("backing-bid", () =>
      buildBidCalls({
        auction: round.auction,
        plan: bidPlanWithDefaultHint(
          { maxPriceQ96: limit, amount: budget, owner: me, hookData: "0x" },
          grid.floorPriceX96,
        ),
        currency: token.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + BID_DEADLINE_SECONDS),
        underlyingAllowance: grid.permit2Allowance,
      }).map((call) => ({
        to: call.to,
        data: call.data,
        ...(call.value === "0x0" ? {} : { value: call.value }),
      })),
    );
    if (placed) onDone();
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-testid="backing-bid-form"
      id="backing-bid-form"
      onSubmit={submit}
    >
      <label className="text-sm font-medium" htmlFor={`${base}-amount`}>
        How much to bid{token.symbol ? ` (${token.symbol})` : ""}
      </label>
      <Input
        aria-describedby={`${base}-plan${gateNoteId ? ` ${gateNoteId}` : ""}`}
        autoComplete="off"
        className="max-sm:h-11"
        data-testid="backing-bid-amount"
        id={`${base}-amount`}
        inputMode="decimal"
        onChange={(event) => setAmount(event.target.value)}
        placeholder="10"
        ref={field}
        value={amount}
      />
      <label className="text-sm font-medium" htmlFor={`${base}-price`}>
        Highest price you will pay for one unit
        {token.symbol ? ` (${token.symbol})` : ""}
      </label>
      <Input
        aria-describedby={`${base}-plan`}
        autoComplete="off"
        className="max-sm:h-11"
        data-testid="backing-bid-price"
        id={`${base}-price`}
        inputMode="decimal"
        onChange={(event) => setPrice(event.target.value)}
        ref={priceField}
        value={price}
      />
      <p
        aria-live="polite"
        className="min-h-5 text-sm"
        data-testid="backing-bid-plan"
        id={`${base}-plan`}
        role="status"
      >
        {grid
          ? `The lowest price a bid can have is ${formatRoundPrice(grid.floorPriceX96, token.decimals)}, and prices move in steps of ${formatRoundPrice(grid.tickSpacingX96, token.decimals)}. Your highest price is raised to the next step.`
          : ""}
        {tried && problem ? (
          <span
            className="block text-destructive"
            data-testid="backing-problem"
          >
            {problem}
          </span>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">
        Your money is spent a little at a time at the round's price. If the
        price rises above your highest price, you stop buying and the rest of
        your money can be taken back.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          className="max-sm:h-11"
          data-testid="backing-confirm-bid"
          disabled={blocked}
          type="submit"
        >
          {busy === "backing-bid" ? "Bidding…" : "Place my bid"}
        </Button>
        <Button
          className="max-sm:h-11"
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
