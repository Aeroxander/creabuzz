import { PERMIT2_ADDRESS } from "@creaton/core/launchpad/evmAbi.ts";
import { useId, useState } from "react";
import { tradingOn } from "../../lib/server";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { parseDollars } from "../money/calls";
import { OwnershipLine } from "../money/MoneyTab";
import { dollarsText, type ProjectNumbers, sharesText } from "../money/numbers";
import { auctionState } from "../money/numbers-market";
import {
  readQuote,
  useConnectWallet,
  useWalletAddress,
} from "../money/use-money";
import { SendButton, SendSheet } from "../team/SendSheet";
import { DisclosureBody } from "./AuctionDisclosure";
import { readWord } from "../team/use-team";
import {
  bidCalls,
  handBackCalls,
  MARKET_READS,
  topPriceQ96,
  tradeCalls,
} from "./market-calls";
import {
  buyMoves,
  floorPerShare,
  handBackPaid,
  percentText,
  poolSharePrice,
  priceText,
  sharePriceFromQ96,
} from "./market-math";
import {
  readFinishCalls,
  SALE_STAGE,
  type SaleStage,
  useBlock,
  useFloor,
  usePool,
  useSaleStage,
} from "./use-market";

const SHARE = 10n ** 18n;

/** The trade router the build names (`VITE_CREATON_ROUTER`), or null: then Buy and Sell are not offered. */
function builtRouter(
  env: Record<string, unknown> = import.meta.env,
): string | null {
  const router = env.VITE_CREATON_ROUTER;
  return typeof router === "string" && /^0x[0-9a-fA-F]{40}$/.test(router)
    ? router.toLowerCase()
    : null;
}

/** Whole Shares typed by a person as raw units, or null (digits only, at least 1). */
export function parseShares(text: string): bigint | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d{1,12}$/.test(cleaned)) return null;
  const whole = BigInt(cleaned);
  return whole > 0n ? whole * SHARE : null;
}

/**
 * The market's next step above the project's tabs, loaded only where investing is on and the project has numbers:
 * Bid while the auction takes bids, Finish once it ended, and once a pool is open its price beside its depth with Hand
 * back (and Buy and Sell where trading is on). Each is 2 presses and 1 field.
 */
export function MarketTop({ numbers }: { numbers: ProjectNumbers }) {
  const sale = numbers.market.sale;
  const block = useBlock(numbers).data ?? numbers.asOf.block;
  const stage = useSaleStage(numbers).data;
  if (!sale || numbers.clock.woundDown) return null;
  const state = auctionState(sale, block);
  if (state === "bidding" || state === "closing")
    return <BidBox closing={state === "closing"} numbers={numbers} />;
  if (state === "ended" && !sale.pool)
    // A sale that missed its minimum stays in the record as the one sale: the chain says it is closed and may be opened again.
    return stage?.stage === SALE_STAGE.failed ? (
      <FailedSaleBox block={block} retryBlock={stage.retryBlock} />
    ) : (
      <FinishBox numbers={numbers} stage={stage} />
    );
  if (sale.pool) return <PoolBox numbers={numbers} />;
  return null;
}

function BidBox({
  numbers,
  closing,
}: {
  numbers: ProjectNumbers;
  closing: boolean;
}) {
  const sale = numbers.market.sale;
  const me = useWalletAddress().data ?? null;
  const connect = useConnectWallet();
  const titleId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sale) return null;
  const totals = numbers.market.bids.find((b) => b.auction === sale.auction);
  const parsed = parseDollars(text);
  const start = sharePriceFromQ96(sale.floorPriceQ96);
  const top = sharePriceFromQ96(topPriceQ96(sale.floorPriceQ96));
  const rounds = numbers.contracts.rounds;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="bid-box"
      role="region"
    >
      <div>
        <h2 className="headline text-xl" id={titleId}>
          The auction is open
        </h2>
        <p className="mt-1 text-sm text-muted">
          250,000,000 Shares, starting at {priceText(start)} dollars a Share;
          the most anyone pays is {priceText(top)}. It needs{" "}
          {dollarsText(sale.minimum)} dollars in bids, or every bid comes back
          in full.{" "}
          {totals
            ? `${dollarsText(totals.amount)} dollars bid so far by ${totals.count} ${totals.count === 1 ? "bid" : "bids"}.`
            : ""}
        </p>
      </div>
      {closing ? (
        <p className="text-sm" data-testid="bid-closing">
          Bids are closed for the last stretch of the auction. It ends soon.
        </p>
      ) : (
        <>
          <Field
            autoComplete="off"
            problem={error}
            inputMode="decimal"
            label="Dollars to bid"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            data-testid="bid-amount"
            value={text}
          />
          <Button
            block
            data-testid="bid-review"
            onClick={() => {
              if (!parsed.ok)
                return setError(
                  parsed.reason === "small"
                    ? "A bid is at least 1 dollar."
                    : "Type an amount in dollars, like 250.",
                );
              if (!rounds)
                return setError(
                  "This project's page does not say where its money goes yet. Try again in a moment.",
                );
              // A wallet that has shared no account with this site is asked to first: the sheet needs the account.
              if (!me)
                return connect.mutate(undefined, {
                  onSuccess: () => setOpen(true),
                  onError: () =>
                    setError(
                      "Your wallet did not share an account. Allow it there, then press Bid again.",
                    ),
                });
              setOpen(true);
            }}
          >
            Bid
          </Button>
        </>
      )}
      {parsed.ok && rounds && me ? (
        <SendSheet
          // The amount is part of the step: a waiting bid of another amount is never taken for this one.
          action={`bid:${numbers.chainId}:${sale.auction}:${parsed.raw}`}
          build={async (wallet) => {
            const quote = await readQuote(wallet, rounds);
            const from = await wallet.getAddress();
            const allowance = await readWord(
              wallet,
              quote,
              MARKET_READS.allowance(from, PERMIT2_ADDRESS),
            );
            return bidCalls({
              auction: sale.auction,
              quote,
              owner: from,
              amount: parsed.raw,
              floorQ96: sale.floorPriceQ96,
              permit2Allowance: allowance,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
            });
          }}
          chainId={numbers.chainId}
          confirmLabel="Place the bid"
          copy="bid"
          done="Your bid is in. Collect your Shares and any unused dollars when the auction ends."
          onOpenChange={setOpen}
          open={open}
          testId="bid-sheet"
          title={`Bid ${dollarsText(parsed.raw)} dollars?`}
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              The price moves as bids come in. Your bid is filled at the price
              of each moment it is live, so an early bid can cost less than a
              later one. No Share costs more than {priceText(top)} dollars, so
              your {dollarsText(parsed.raw)} dollars buy at least{" "}
              {sharesText(
                BigInt(Math.floor(Number(parsed.raw) / 1e6 / top)) * SHARE,
              )}{" "}
              Shares.
            </li>
            <li>
              If the auction does not reach {dollarsText(sale.minimum)} dollars,
              your bid comes back in full.
            </li>
            <li>
              Shares bought in the auction are not held back for 365 days. After
              it ends you collect them on the project's Money tab.
            </li>
          </ul>
          <h3 className="mt-1 font-semibold">Before you bid</h3>
          <DisclosureBody idPrefix="bid-disclosure" numbers={numbers} />
          <OwnershipLine />
        </SendSheet>
      ) : null}
    </Card>
  );
}

function FailedSaleBox({
  block,
  retryBlock,
}: {
  block: number;
  retryBlock: number;
}) {
  const titleId = useId();
  const wait = Math.max(0, retryBlock - block);
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-2"
      data-testid="failed-sale"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        The auction did not reach its minimum
      </h2>
      <p className="text-sm text-muted">
        Every bid comes back in full: bidders collect on the project's Money
        tab. The people running the project can open an auction again{" "}
        {wait === 0
          ? "now."
          : `from block ${retryBlock}, in ${wait} more ${wait === 1 ? "block" : "blocks"}.`}
      </p>
    </Card>
  );
}

function FinishBox({
  numbers,
  stage,
}: {
  numbers: ProjectNumbers;
  stage: SaleStage | undefined;
}) {
  const titleId = useId();
  const sale = numbers.market.sale;
  const finisher = numbers.market.finisher;
  const totals = numbers.market.bids.find((b) => b.auction === sale?.auction);
  if (!sale || !finisher) return null;
  const reached = (totals?.amount ?? 0n) >= sale.minimum;
  // Finished on the network while the record has not caught up: nothing is left to press.
  const finished =
    stage?.stage === SALE_STAGE.done || stage?.stage === SALE_STAGE.abandoned;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="finish-box"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        The auction has ended
      </h2>
      <p className="text-sm text-muted">
        {reached
          ? "It reached its minimum. Finishing opens the pool, splits the money and returns unsold Shares. The server's helper usually does it within minutes; anyone may press it."
          : "It did not reach its minimum, so every bid comes back in full. Closing it lets bidders take their dollars back. Anyone may press it."}
      </p>
      {finished ? (
        <p className="text-sm" data-testid="finish-done">
          It is finished. The numbers here catch up in a moment.
        </p>
      ) : (
        <SendButton
          // The sale's stage is part of the step: a finish that landed earlier is never taken for the next one.
          action={`finish:${numbers.chainId}:${finisher}:${stage?.stage ?? "unread"}`}
          block
          build={(wallet) =>
            readFinishCalls(wallet, finisher, sale.auction, reached)
          }
          chainId={numbers.chainId}
          copy="finish"
          done="Done. The numbers here catch up in a moment."
          label={reached ? "Finish the sale" : "Close the sale"}
          testId="finish-press"
          variant="secondary"
        />
      )}
    </Card>
  );
}

function PoolBox({ numbers }: { numbers: ProjectNumbers }) {
  const titleId = useId();
  const pool = usePool(numbers).data;
  const floor = useFloor(numbers).data;
  const [sheet, setSheet] = useState<"hand-back" | "buy" | "sell" | null>(null);
  const sale = numbers.market.sale;
  const shares = numbers.contracts.shares;
  const treasury = numbers.contracts.treasury;
  const router = tradingOn() ? builtRouter() : null;
  if (!sale?.pool || !shares || !treasury) return null;
  const clearing = numbers.market.bids.find(
    (b) => b.auction === sale.auction,
  )?.clearingPriceQ96;
  // The pool's own price once read; until then the price the auction ended at.
  const price = pool
    ? poolSharePrice(pool.sqrtPriceX96, pool.sharesAreCurrency0)
    : clearing
      ? sharePriceFromQ96(clearing)
      : 0;
  const moves = pool
    ? buyMoves({
        sqrtPriceX96: pool.sqrtPriceX96,
        liquidity: pool.liquidity,
        sharesAreCurrency0: pool.sharesAreCurrency0,
        dollars: 100_000_000n,
      })
    : null;
  const floorNow = floor ? floorPerShare(floor, 0) : null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="pool-box"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        The market is open
      </h2>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-muted">Price in the pool</dt>
          <dd className="num font-semibold" data-testid="pool-price">
            {priceText(price)} dollars a Share
          </dd>
        </div>
        <div>
          <dt className="text-muted">Depth</dt>
          <dd className="font-semibold" data-testid="pool-depth">
            {moves === null
              ? "Not read yet"
              : `A 100-dollar buy moves it about ${percentText(moves)}`}
          </dd>
        </div>
        {floorNow !== null ? (
          <div className="col-span-2">
            <dt className="text-muted">Floor</dt>
            <dd className="num font-semibold" data-testid="pool-floor">
              {priceText(floorNow)} dollars a Share, melting over the year
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        {floor?.saleClosed ? (
          <Button
            data-testid="hand-back"
            onClick={() => setSheet("hand-back")}
            size="sm"
            variant="secondary"
          >
            Hand back
          </Button>
        ) : null}
        {router && pool ? (
          <>
            <Button
              data-testid="buy"
              onClick={() => setSheet("buy")}
              size="sm"
              variant="secondary"
            >
              Buy
            </Button>
            <Button
              data-testid="sell"
              onClick={() => setSheet("sell")}
              size="sm"
              variant="secondary"
            >
              Sell
            </Button>
          </>
        ) : null}
      </div>
      {floor && floorNow !== null ? (
        <HandBackSheet
          floorNow={floorNow}
          numbers={numbers}
          onOpenChange={(o) => setSheet(o ? "hand-back" : null)}
          open={sheet === "hand-back"}
          shares={shares}
          treasury={treasury}
        />
      ) : null}
      {router && pool ? (
        <TradeSheet
          numbers={numbers}
          onOpenChange={(o) => setSheet(o ? sheet : null)}
          pool={pool}
          price={price}
          router={router}
          side={sheet === "sell" ? "sell" : "buy"}
          open={sheet === "buy" || sheet === "sell"}
        />
      ) : null}
    </Card>
  );
}

function HandBackSheet({
  numbers,
  shares,
  treasury,
  floorNow,
  open,
  onOpenChange,
}: {
  numbers: ProjectNumbers;
  shares: string;
  treasury: string;
  floorNow: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const amount = parseShares(text);
  const slice = amount
    ? BigInt(Math.floor(Number(amount / SHARE) * floorNow * 1e6))
    : 0n;
  const paid = handBackPaid(slice, numbers.clock.woundDown);
  return (
    <SendSheet
      action={`hand-back:${numbers.chainId}:${treasury}:${amount ?? 0n}`}
      build={() => (amount ? handBackCalls(shares, treasury, amount) : [])}
      chainId={numbers.chainId}
      confirmLabel="Hand back"
      copy="hand-back"
      disabled={!amount}
      done="Handed back. The dollars are in your wallet."
      onOpenChange={onOpenChange}
      open={open}
      testId="hand-back-sheet"
      title="Hand Shares back at the floor"
    >
      <Field
        inputMode="numeric"
        label="Shares to hand back"
        onChange={(e) => setText(e.target.value)}
        data-testid="hand-back-amount"
        value={text}
      />
      <p data-testid="hand-back-estimate">
        {amount
          ? `About ${dollarsText(paid)} dollars come back: the floor's ${priceText(floorNow)} a Share, less ${numbers.clock.woundDown ? "the platform's 1" : "5"} of each 100. The Shares are burned. Only free Shares can be handed back; held ones cannot until they are released.`
          : "Type how many free Shares to hand back."}
      </p>
    </SendSheet>
  );
}

function TradeSheet({
  numbers,
  pool,
  router,
  price,
  side,
  open,
  onOpenChange,
}: {
  numbers: ProjectNumbers;
  pool: NonNullable<ReturnType<typeof usePool>["data"]>;
  router: string;
  price: number;
  side: "buy" | "sell";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const shares = numbers.contracts.shares ?? "";
  const dollarsToken = pool.sharesAreCurrency0
    ? pool.key.currency1
    : pool.key.currency0;
  const parsedDollars = parseDollars(text);
  const amountIn =
    side === "buy"
      ? parsedDollars.ok
        ? parsedDollars.raw
        : null
      : parseShares(text);
  return (
    <SendSheet
      action={`trade-${side}:${numbers.chainId}:${shares}:${amountIn ?? 0n}`}
      build={async (wallet) => {
        if (!amountIn) return [];
        const from = await wallet.getAddress();
        const tokenIn = side === "buy" ? dollarsToken : shares;
        const allowance = await readWord(
          wallet,
          tokenIn,
          MARKET_READS.allowance(from, PERMIT2_ADDRESS),
        );
        return tradeCalls({
          router,
          key: pool.key,
          tokenIn,
          amountIn,
          // At least 95 of each 100 of what the price now gives: a trade that would fill worse than that is refused.
          minOut:
            side === "buy"
              ? BigInt(Math.floor((Number(amountIn) / 1e6 / price) * 0.95)) *
                SHARE
              : BigInt(
                  Math.floor(Number(amountIn / SHARE) * price * 0.95 * 1e6),
                ),
          permit2Allowance: allowance,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        });
      }}
      chainId={numbers.chainId}
      confirmLabel={side === "buy" ? "Buy" : "Sell"}
      copy="trade"
      disabled={!amountIn}
      done={side === "buy" ? "Bought." : "Sold."}
      onOpenChange={(next) => {
        // The field is dollars under Buy and Shares under Sell: an amount typed for one is never carried to the other.
        if (!next) setText("");
        onOpenChange(next);
      }}
      open={open}
      testId="trade-sheet"
      title={
        side === "buy" ? "Buy Shares in the pool" : "Sell Shares in the pool"
      }
    >
      <Field
        inputMode="decimal"
        label={side === "buy" ? "Dollars to spend" : "Shares to sell"}
        onChange={(e) => setText(e.target.value)}
        data-testid="trade-amount"
        value={text}
      />
      <p>
        At about {priceText(price)} dollars a Share now. The pool keeps 1 of
        each 100 traded, and the trade is refused if it would fill more than 5
        of each 100 worse than that.
      </p>
      <OwnershipLine />
    </SendSheet>
  );
}
