import { useId } from "react";
import { Card } from "../../ui/card";
import { priceLine } from "../money/MoneyTab";
import { dollarsText, type ProjectNumbers, sharesText } from "../money/numbers";
import { topPriceQ96 } from "./market-calls";
import { priceText, sharePriceFromQ96 } from "./market-math";

/** The auction's starting price when no sale is open yet: 0.0004 dollars a Share (`Launcher.salePrices`). */
const DEFAULT_START = 0.0004;

/**
 * What a bidder must know before bidding (plan section 6): how many Shares are already held, by how many accounts, at
 * what price they were got, and when they release, then what the auction offers. Shown on the Money tab and again in the
 * bid sheet, so nobody bids from the project's first screen without it. `idPrefix` names its parts for tests.
 */
export function DisclosureBody({
  numbers,
  idPrefix,
}: {
  numbers: ProjectNumbers;
  idPrefix: string;
}) {
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
    <>
      <p data-testid={`${idPrefix}-held`}>
        {cut ? "At least " : ""}
        <span className="num">{sharesText(held + free)}</span> Shares are
        already held, by {numbers.holderCount}{" "}
        {numbers.holderCount === 1 ? "account" : "accounts"}. Accounts are free,
        so one person can have several.
      </p>
      <ul
        className="flex list-disc flex-col gap-1 pl-5"
        data-testid={`${idPrefix}-prices`}
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
      <p data-testid={`${idPrefix}-release`}>
        Held Shares are released evenly over 365 days from the day the market
        opens, so they can be sold into the pool or handed back only bit by bit.
        Shares bought in the auction are not held back: you collect them when
        the auction ends.
      </p>
      <p data-testid={`${idPrefix}-auction`}>
        The auction offers 250,000,000 Shares from {priceText(start)} dollars a
        Share; nobody pays more than {priceText(top)}. It needs{" "}
        {sale ? dollarsText(sale.minimum) : "100,000"} dollars in bids or
        refunds every bid in full.
      </p>
    </>
  );
}

/** The disclosure as a card, on the Money tab. */
export function Disclosure({ numbers }: { numbers: ProjectNumbers }) {
  const titleId = useId();
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
      <DisclosureBody idPrefix="disclosure" numbers={numbers} />
    </Card>
  );
}
