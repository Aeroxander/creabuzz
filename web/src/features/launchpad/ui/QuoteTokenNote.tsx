/**
 * Which token a market's prices are in: its symbol and short address with a way to copy the whole address, and a plain
 * warning when it is not the project's sale currency.
 *
 * A token names itself, and the founder chooses it, so the symbol alone proves nothing: a worthless token can call
 * itself "USDC". The words come from `quoteIdentity` (`trading-copy.ts`), so the card, the listing form and the vote
 * all say the same thing, and the comparison is on the whole address, never the short form.
 */

import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { MoreInfo } from "@/shared/ui/more-info";

import { quoteIdentity } from "../lib/trading-copy";

export function QuoteTokenNote({
  symbol,
  address,
  saleCurrency,
}: {
  /** The price token's own symbol. */
  symbol: string;
  /** The price token's full address. */
  address: string;
  /** The project's recorded sale currency, when it has one. */
  saleCurrency: string | null | undefined;
}) {
  const identity = quoteIdentity({ symbol, address }, saleCurrency);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(identity.address);
      toast.success("Token address copied.");
    } catch {
      toast.error("Copy failed. Open the full address and copy it by hand.");
    }
  };
  return (
    <div className="mt-2 grid gap-1" data-testid="quote-token">
      <p className="text-sm" data-testid="quote-token-line">
        {identity.line}{" "}
        <Button
          aria-label={`Copy address, price token ${identity.short}`}
          data-testid="quote-token-copy"
          onClick={() => void copy()}
          size="sm"
          type="button"
          variant="ghost"
        >
          Copy address
        </Button>
      </p>
      {identity.warning ? (
        <p
          className="rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="quote-token-warning"
          role="note"
        >
          {identity.warning}
        </p>
      ) : null}
      <MoreInfo label="Full token address" testId="quote-token-full">
        <code className="break-all">{identity.address}</code>
      </MoreInfo>
    </div>
  );
}
