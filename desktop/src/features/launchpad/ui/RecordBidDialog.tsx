import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

export type RecordBidForm = {
  bucket: string;
  budget: string;
  maxPrice: string;
  tx: string;
};

/**
 * Investor flow: after bidding onchain, paste the tx hash to mirror the bid
 * into the launch feed. Mirrors are advisory — settlement is onchain.
 */
export function RecordBidDialog({
  isPublishing,
  onPublish,
  onOpenChange,
  open,
  launchName,
}: {
  isPublishing: boolean;
  onPublish: (input: RecordBidForm) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  launchName: string;
}) {
  const [bucket, setBucket] = React.useState("bucket-0");
  const [budget, setBudget] = React.useState("");
  const [maxPrice, setMaxPrice] = React.useState("");
  const [tx, setTx] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setBucket("bucket-0");
      setBudget("");
      setMaxPrice("");
      setTx("");
      setError(null);
    }
  }, [open]);

  const submit = () => {
    if (isPublishing) return;
    if (tx.trim() !== "" && !/^0x[0-9a-fA-F]{64}$/.test(tx.trim())) {
      setError("Transaction hash must be 0x + 64 hex characters.");
      return;
    }
    setError(null);
    void onPublish({
      bucket: bucket.trim() || "bucket-0",
      budget: budget.trim(),
      maxPrice: maxPrice.trim(),
      tx: tx.trim(),
    });
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && isPublishing) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent aria-label={`Back ${launchName}`}>
        <DialogHeader>
          <DialogTitle>Back {launchName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-1 py-2">
          <p className="text-sm text-muted-foreground">
            Bid on the auction contract first, then record it here with the
            transaction hash. Your bid settles onchain — this mirror feeds the
            launch timeline and notifications.
          </p>
          <div>
            <label className="text-sm font-medium" htmlFor="bid-bucket">
              Bucket
            </label>
            <span className="mt-1 block">
              <Input
                id="bid-bucket"
                onChange={(e) => setBucket(e.target.value)}
                placeholder="bucket-0"
                value={bucket}
              />
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium" htmlFor="bid-budget">
                Budget
              </label>
              <span className="mt-1 block">
                <Input
                  id="bid-budget"
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="1000000"
                  value={budget}
                />
              </span>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="bid-max-price">
                Max price
              </label>
              <span className="mt-1 block">
                <Input
                  id="bid-max-price"
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="2000000"
                  value={maxPrice}
                />
              </span>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="bid-tx">
              Transaction hash
            </label>
            <span className="mt-1 block">
              <Input
                id="bid-tx"
                onChange={(e) => setTx(e.target.value)}
                placeholder="0x…"
                value={tx}
              />
            </span>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button disabled={isPublishing} onClick={submit} type="button">
            {isPublishing ? "Recording…" : "Record bid"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
