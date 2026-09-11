import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Modal } from "./Modal";

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/** Investor flow: bid onchain first, then mirror the tx hash into the feed. */
export function RecordBidDialog({
  isPublishing,
  launchName,
  onClose,
  onPublish,
}: {
  isPublishing: boolean;
  launchName: string;
  onClose: () => void;
  onPublish: (input: {
    bucket: string;
    budget: string;
    maxPrice: string;
    tx: string;
  }) => Promise<void>;
}) {
  const [bucket, setBucket] = useState("bucket-0");
  const [budget, setBudget] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [tx, setTx] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (isPublishing) return;
    if (tx.trim() !== "" && !TX_RE.test(tx.trim())) {
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
    <Modal label={`Back ${launchName}`} onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Back {launchName}
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Bid on the auction contract first, then record it here. Settlement is
        onchain — this mirror feeds the launch timeline.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="bid-bucket">
            Bucket
          </label>
          <Input
            id="bid-bucket"
            className="mt-1"
            onChange={(e) => setBucket(e.target.value)}
            placeholder="bucket-0"
            value={bucket}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium" htmlFor="bid-budget">
              Budget
            </label>
            <Input
              id="bid-budget"
              className="mt-1"
              onChange={(e) => setBudget(e.target.value)}
              placeholder="1000000"
              value={budget}
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="bid-max-price">
              Max price
            </label>
            <Input
              id="bid-max-price"
              className="mt-1"
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="2000000"
              value={maxPrice}
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="bid-tx">
            Transaction hash
          </label>
          <Input
            id="bid-tx"
            className="mt-1"
            onChange={(e) => setTx(e.target.value)}
            placeholder="0x…"
            value={tx}
          />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
      <div className="mt-4 flex justify-end">
        <Button disabled={isPublishing} onClick={submit} type="button">
          {isPublishing ? "Recording…" : "Record bid"}
        </Button>
      </div>
    </Modal>
  );
}
