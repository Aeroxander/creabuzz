import { useId } from "react";
import { Card } from "../../ui/card";
import { priceLine } from "../money/MoneyTab";
import {
  dayText,
  dollarsText,
  type ProjectNumbers,
  sharesText,
} from "../money/numbers";
import { useWalletAddress } from "../money/use-money";
import { SendButton } from "../team/SendSheet";
import { collectCalls, topPriceQ96 } from "./market-calls";
import {
  type FloorNow,
  floorLine,
  floorPerShare,
  priceText,
  sharePriceFromQ96,
} from "./market-math";
import { type MyBid, useFloor, useMyBids } from "./use-market";

/** The auction's starting price when no sale is open yet: 0.0004 dollars a Share (`Launcher.salePrices`). */
const DEFAULT_START = 0.0004;

/**
 * The market on the Money tab: before and during the auction, what a bidder must know (who already holds Shares, at
 * what price, and when they release); after it, the floor as a melting line and this wallet's bids to collect.
 */
export function MarketMoney({ numbers }: { numbers: ProjectNumbers }) {
  const sale = numbers.market.sale;
  const beforeMarket =
    !sale?.pool &&
    (numbers.stage.name === "team" || Boolean(sale)) &&
    !numbers.clock.woundDown;
  return (
    <div className="flex flex-col gap-3" data-testid="market-money">
      {beforeMarket ? <Disclosure numbers={numbers} /> : null}
      {sale?.settled ? <FloorCard numbers={numbers} /> : null}
      {sale ? <MyBids numbers={numbers} /> : null}
    </div>
  );
}

function Disclosure({ numbers }: { numbers: ProjectNumbers }) {
  const titleId = useId();
  const sale = numbers.market.sale;
  const start = sale ? sharePriceFromQ96(sale.floorPriceQ96) : DEFAULT_START;
  const top = sale
    ? sharePriceFromQ96(topPriceQ96(sale.floorPriceQ96))
    : DEFAULT_START * 4;
  const held = numbers.holders.reduce((sum, h) => sum + h.held, 0n);
  const free = numbers.holders.reduce((sum, h) => sum + h.free, 0n);
  const cut = numbers.holders.length < numbers.holderCount;
  const closed = numbers.rounds.filter(
    (r) => r.closed && (r.accepted ?? 0n) > 0n,
  );
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-2 text-sm"
      data-testid="auction-disclosure"
      role="region"
    >
      <h3 className="font-semibold" id={titleId}>
        Before you bid
      </h3>
      <p data-testid="disclosure-held">
        {cut ? "At least " : ""}
        <span className="num">{sharesText(held + free)}</span> Shares are
        already held, by {numbers.holderCount}{" "}
        {numbers.holderCount === 1 ? "account" : "accounts"}. Accounts are free,
        so one person can have several.
      </p>
      <ul
        className="flex list-disc flex-col gap-1 pl-5"
        data-testid="disclosure-prices"
      >
        <li>The founder's 200,000,000 cost nothing.</li>
        {closed.map((r) => (
          <li key={r.round}>
            Round {r.round}: {dollarsText(r.accepted ?? 0n)} dollars, where{" "}
            {priceLine(r)}.
          </li>
        ))}
        <li>Shares given for work cost nothing.</li>
      </ul>
      <p data-testid="disclosure-release">
        Held Shares are released evenly over 365 days from the day the market
        opens, so they can be sold into the pool or handed back only bit by bit.
        Shares bought in the auction are free at once.
      </p>
      <p data-testid="disclosure-auction">
        The auction offers 250,000,000 Shares from {priceText(start)} dollars a
        Share; nobody pays more than {priceText(top)}. It needs{" "}
        {sale ? dollarsText(sale.minimum) : "100,000"} dollars in bids or
        refunds every bid in full.
      </p>
    </Card>
  );
}

/** The floor per Share as a line falling to its permanent part over the active days left (it pauses when quiet). */
function FloorCard({ numbers }: { numbers: ProjectNumbers }) {
  const floor = useFloor(numbers).data;
  const titleId = useId();
  if (!floor) return null;
  const now = floorPerShare(floor, 0);
  const days = Math.round(Number(floor.meltRemaining) / 86_400);
  const end = floorPerShare(floor, Number(floor.meltRemaining));
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-2"
      data-testid="floor-card"
      role="region"
    >
      <h3 className="font-semibold" id={titleId}>
        The floor
      </h3>
      <p className="text-sm">
        A free Share can be handed back for about{" "}
        <span className="num font-semibold">{priceText(now)}</span> dollars now
        (before the 5 of each 100 fee). It melts into the project's money over{" "}
        {days} active days, down to {priceText(end)}, the part that never melts.
      </p>
      <FloorLine
        floor={floor}
        label={`Floor per Share from ${priceText(now)} dollars now to ${priceText(end)} in ${days} active days`}
      />
      <p className="text-xs text-muted">
        Active days count only while the founder checks in. As of{" "}
        {dayText(numbers.asOf.time)}.
      </p>
    </Card>
  );
}

function FloorLine({ floor, label }: { floor: FloorNow; label: string }) {
  const points = floorLine(floor);
  const top = Math.max(...points.map((p) => p.perShare), 1e-12);
  const lastDay = Math.max(points[points.length - 1]?.day ?? 1, 1);
  const path = points
    .map((p, i) => {
      const x = (p.day / lastDay) * 300;
      const y = 76 - (p.perShare / top) * 70;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      aria-label={label}
      className="h-20 w-full text-mint-ink"
      data-testid="floor-line"
      preserveAspectRatio="none"
      role="img"
      viewBox="0 0 300 80"
    >
      <line
        className="text-white/20"
        stroke="currentColor"
        x1="0"
        x2="300"
        y1="78"
        y2="78"
      />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MyBids({ numbers }: { numbers: ProjectNumbers }) {
  const me = useWalletAddress().data ?? null;
  const read = useMyBids(numbers, me);
  const sale = numbers.market.sale;
  if (!sale || !read.data || read.data.bids.length === 0) return null;
  const { graduated, claimBlock, clearingQ96 } = read.data;
  const head = read.data.head;
  const ended = head > sale.endBlock;
  return (
    <Card className="flex flex-col gap-2" data-testid="my-bids">
      <h3 className="font-semibold">Your bids</h3>
      <ul className="flex flex-col gap-2">
        {read.data.bids.map((bid) => (
          <BidLine
            bid={bid}
            claimable={graduated && BigInt(head) >= claimBlock}
            clearingQ96={clearingQ96}
            ended={ended}
            graduated={graduated}
            key={bid.id.toString()}
            numbers={numbers}
          />
        ))}
      </ul>
    </Card>
  );
}

function BidLine({
  numbers,
  bid,
  ended,
  graduated,
  claimable,
  clearingQ96,
}: {
  numbers: ProjectNumbers;
  bid: MyBid;
  ended: boolean;
  graduated: boolean;
  claimable: boolean;
  clearingQ96: bigint;
}) {
  const sale = numbers.market.sale;
  if (!sale) return null;
  // A bid at exactly the final price was only partly filled: settling it needs hints the app does not work out yet.
  const partial = graduated && !bid.exited && bid.maxPriceQ96 === clearingQ96;
  const exit = ended && !bid.exited && !partial;
  const claim = claimable && (bid.tokensFilled > 0n || exit);
  const words = !ended
    ? "Waiting for the auction to end."
    : partial
      ? "Partly filled at the final price. Collecting it from the app is not ready yet."
      : !graduated
        ? bid.exited
          ? "Refunded in full."
          : "The auction did not reach its minimum: collect your dollars."
        : bid.exited && bid.tokensFilled === 0n
          ? "Collected."
          : "Filled. Collect your Shares and any dollars not used.";
  return (
    <li
      className="flex items-center justify-between gap-3 text-sm"
      data-testid="my-bid"
    >
      <div className="min-w-0">
        <p className="font-semibold">{dollarsText(bid.amount)} dollars</p>
        <p className="text-xs text-muted">{words}</p>
      </div>
      {exit || claim ? (
        <SendButton
          action={`collect:${numbers.chainId}:${sale.auction}:${bid.id}`}
          build={() => collectCalls(sale.auction, bid.id, { exit, claim })}
          chainId={numbers.chainId}
          copy="collect"
          done="Collected."
          label="Collect"
          testId="collect-bid"
          variant="secondary"
        />
      ) : null}
    </li>
  );
}
