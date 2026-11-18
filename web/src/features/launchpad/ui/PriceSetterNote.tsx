import { priceSetterLine } from "../lib/trading-copy";

/**
 * The permanent line beside a weekly round's price, saying who can set it. Plain visible text, not a tooltip or a
 * disclosure, with no label of its own and nothing to dismiss, so a screen reader reads it in place as ordinary text.
 * Callers render it only where a price is printed (`roundShowsPrice` and its siblings), never where none is.
 */
export function PriceSetterNote() {
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="price-setter-note"
    >
      {priceSetterLine()}
    </p>
  );
}
