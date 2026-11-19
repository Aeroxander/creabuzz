import { useId } from "react";
import { Card } from "../../ui/card";
import { dayText, dollarsText, type ProjectNumbers } from "../money/numbers";
import { useWalletAddress } from "../money/use-money";
import type { MoneyWallet } from "../money/wallet";
import { SendButton } from "../team/SendSheet";
import { Disclosure } from "./AuctionDisclosure";
import { type ExitPlan, exitCall, readExitPlan } from "./exit-plan";
import { collectCalls } from "./market-calls";
import {
  type FloorNow,
  floorLine,
  floorPerShare,
  priceText,
} from "./market-math";
import {
  type MyBid,
  SALE_STAGE,
  useFloor,
  useMyBids,
  useSaleStage,
} from "./use-market";

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
  const stage = useSaleStage(numbers).data;
  const sale = numbers.market.sale;
  if (!sale || !read.data || read.data.bids.length === 0) return null;
  const { graduated, claimBlock } = read.data;
  const head = read.data.head;
  const ended = head > sale.endBlock;
  // Only a finished sale says what became of the bids: until its pool step ran, the auction still reads as not
  // graduated whatever it raised, and collecting would be refused.
  const finished =
    stage?.stage === SALE_STAGE.done ||
    stage?.stage === SALE_STAGE.failed ||
    stage?.stage === SALE_STAGE.abandoned;
  return (
    <Card className="flex flex-col gap-2" data-testid="my-bids">
      <h3 className="font-semibold">Your bids</h3>
      <ul className="flex flex-col gap-2">
        {read.data.bids.map((bid) => (
          <BidLine
            bid={bid}
            claimable={graduated && BigInt(head) >= claimBlock}
            ended={ended}
            finished={finished}
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
  finished,
  graduated,
  claimable,
}: {
  numbers: ProjectNumbers;
  bid: MyBid;
  ended: boolean;
  finished: boolean;
  graduated: boolean;
  claimable: boolean;
}) {
  const sale = numbers.market.sale;
  if (!sale) return null;
  // What settles a bid (all of it back, or the part not used) is read from the auction at the press: a bid at exactly the
  // final price was only partly filled and needs hints only the auction's own records give.
  const exit = ended && finished && !bid.exited;
  const claim = claimable && finished && (bid.tokensFilled > 0n || exit);
  const words = !ended
    ? "Waiting for the auction to end."
    : !finished
      ? "The auction has ended. You can collect once the sale is finished."
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
          build={async (wallet) =>
            collectCalls(sale.auction, bid.id, {
              exit: exit
                ? exitCall(
                    sale.auction,
                    bid.id,
                    await exitFor(wallet, sale.auction, bid.id),
                  )
                : null,
              claim,
            })
          }
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

/** The plan that settles a bid, read from the auction now; a plan that cannot be made is said in words, never guessed. */
async function exitFor(
  wallet: MoneyWallet,
  auction: string,
  bidId: bigint,
): Promise<Extract<ExitPlan, { kind: "exit" | "partial" }>> {
  const plan = await readExitPlan(wallet, auction, bidId);
  if (plan.kind === "unavailable") throw new Error(`exit-${plan.reason}`);
  return plan;
}
