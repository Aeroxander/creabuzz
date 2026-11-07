import { Button } from "@/shared/ui/button";

import type { SaleAction } from "../lib/sale-action";

/**
 * The one main button on a sale page, for where the sale really is (`saleAction`): place a bid while bidding is open, say
 * that it has closed, or take the buyer to their bids to claim tokens or a refund.
 */
export function SaleActionButton({
  action,
  onBid,
  onOpenBids,
}: {
  action: SaleAction;
  onBid: () => void;
  /** Open the buyer's own bids, ready to claim tokens or to take the money back. */
  onOpenBids: (what: "claim" | "exit") => void;
}) {
  if (action.kind === "bid") {
    return <Button onClick={onBid}>{action.label}</Button>;
  }
  if (action.kind === "closed") {
    return (
      <Button disabled variant="outline">
        {action.label}
      </Button>
    );
  }
  return (
    <Button
      onClick={() => onOpenBids(action.kind === "claim" ? "claim" : "exit")}
    >
      {action.label}
    </Button>
  );
}
