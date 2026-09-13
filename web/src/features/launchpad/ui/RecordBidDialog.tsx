import { useEffect, useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Modal } from "./Modal";
import { clearingPrice } from "../chain";
import {
  bidPlanWithDefaultHint,
  buildBidTransaction,
  encodePermit2Approve,
  PERMIT2_ADDRESS,
  validateBid,
  type BidPlan,
} from "../lib/bid-tx";
import { toAtomic } from "../lib/amounts";
import type { LaunchRecord } from "../models";

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

interface BidInput {
  bucket: string;
  budget: string;
  maxPrice: string;
  tx: string;
}

/**
 * Investor flow: bid onchain, then mirror the tx hash into the feed.
 *
 * The dialog composes the real CCA `submitBid` calldata (the exact bytes the
 * contract accepts — `lib/bid-tx.ts`, bound by `BidCalldata.t.sol`), snaps the
 * desired max price onto the auction's tick grid, and validates against the
 * same reverts. When a wallet is present it sends the transaction and records
 * the hash; without a wallet (or an indexer/agent that bid elsewhere) the
 * manual hash entry stays available. The mirror (`Record bid`) is only
 * enabled once a tx hash exists: the chain is the ledger, the mirror is the
 * record, and a mirror with no tx would claim a bid that never landed.
 */
export function RecordBidDialog({
  isPublishing,
  launchName,
  record,
  rpcEndpoint,
  onClose,
  onPublish,
}: {
  isPublishing: boolean;
  launchName: string;
  record: LaunchRecord;
  rpcEndpoint: string;
  onClose: () => void;
  onPublish: (input: BidInput) => Promise<void>;
}) {
  const [bucket, setBucket] = useState("bucket-0");
  const [budget, setBudget] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [tx, setTx] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState<bigint | null>(null);

  const auction = record.auction;
  const floorPriceQ96 = toAtomic(record.floorPrice) ?? null;
  const tickSpacingQ96 = toAtomic(record.tickSpacing) ?? null;

  // Read the clearing price once per opening. A failed read is honest: the
  // contract still enforces "above clearing" at bid time, so the user can
  // proceed, but the dialog cannot pre-check that rule.
  useEffect(() => {
    let alive = true;
    if (!auction) {
      setClearing(null);
      return;
    }
    clearingPrice(rpcEndpoint, auction).then((p) => {
      if (alive) setClearing(p);
    });
    return () => {
      alive = false;
    };
  }, [auction, rpcEndpoint]);

  const budgetAtomic = useMemo(() => toAtomic(budget), [budget]);

  const plan: BidPlan | null = useMemo(() => {
    if (
      floorPriceQ96 === null ||
      tickSpacingQ96 === null ||
      budgetAtomic === null
    ) {
      return null;
    }
    const desired = toAtomic(maxPrice);
    if (desired === null) return null;
    // Snap up to the grid: a price between ticks reverts onchain
    // (TickPriceNotAtBoundary), and snapping up keeps the user's premium
    // rather than silently undercutting it.
    const snapped = desired - (desired % tickSpacingQ96);
    const maxPriceQ96 =
      snapped === desired ? snapped : snapped + tickSpacingQ96;
    return bidPlanWithDefaultHint(
      {
        maxPriceQ96,
        amount: budgetAtomic,
        owner: "0x0000000000000000000000000000000000000000",
        hookData: "0x",
      },
      floorPriceQ96,
    );
  }, [budgetAtomic, floorPriceQ96, maxPrice, tickSpacingQ96]);

  const issues = useMemo(() => {
    if (!plan || tickSpacingQ96 === null || floorPriceQ96 === null) return [];
    // The record does not carry the auction supply, so the ceiling check is
    // skipped (supply null); everything else the contract enforces still
    // holds. When the clearing price is unreadable, the "above clearing" rule
    // is left to the contract rather than guessed.
    return validateBid(
      { ...plan, owner: "0x0000000000000000000000000000000000000000" },
      {
        tickSpacingQ96,
        clearingPriceQ96: clearing ?? 0n,
        supply: null,
      },
    ).filter(
      (i) =>
        !(
          clearing === null &&
          i.field === "maxPrice" &&
          i.message.includes("clearing price")
        ),
    );
  }, [clearing, floorPriceQ96, plan, tickSpacingQ96]);

  const wallet = window.ethereum as
    | {
        request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      }
    | undefined;

  const sendBid = async () => {
    if (!auction || !plan) return;
    setError(null);
    setSending(true);
    try {
      if (!wallet) {
        setError(
          "No wallet found in this browser. Bid on the auction contract directly, then paste the transaction hash below.",
        );
        return;
      }
      const accounts = (await wallet.request({
        method: "eth_requestAccounts",
      })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error("No account selected in the wallet.");
      // Owner is the connected wallet: tokens and refunds settle there.
      const ownerPlan = { ...plan, owner: address };
      // USDC auctions pull via Permit2: approve the auction as spender for
      // the budget before the bid, then submit.
      const calls: Array<{ to: string; value: string; data: string }> = [];
      const currency = record.currency;
      if (currency && /^0x[0-9a-fA-F]{40}$/.test(currency)) {
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
        calls.push({
          to: PERMIT2_ADDRESS,
          value: "0x0",
          data: encodePermit2Approve(
            currency,
            auction,
            ownerPlan.amount,
            deadline,
          ),
        });
      }
      const bidTx = buildBidTransaction(auction, ownerPlan);
      calls.push({
        to: bidTx.to,
        value: bidTx.value,
        data: bidTx.data,
      });
      // One confirm, batched: the wallet decides how (eth_sendTransaction
      // per call or a bundler); we send sequentially, recording each hash.
      let lastHash = "";
      for (const call of calls) {
        const hash = (await wallet.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: address,
              to: call.to,
              value: call.value,
              data: call.data,
            },
          ],
        })) as string;
        lastHash = hash;
      }
      if (!TX_RE.test(lastHash))
        throw new Error("The wallet returned an invalid hash.");
      setTx(lastHash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The bid was not sent.");
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    if (isPublishing) return;
    if (tx.trim() !== "" && !TX_RE.test(tx.trim())) {
      setError("Transaction hash must be 0x + 64 hex characters.");
      return;
    }
    if (tx.trim() === "") {
      setError(
        "Send the bid first, or paste the hash of a bid you made elsewhere.",
      );
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

  const canMirror = tx.trim() !== "" && !isPublishing;
  const canSend =
    auction !== null && plan !== null && issues.length === 0 && !sending;

  return (
    <Modal label={`Back ${launchName}`} onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Back {launchName}
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Your bid is a submitBid call on the auction contract; the feed mirror
        records the transaction hash. The chain is the ledger.
      </p>
      {!auction ? (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This launch has no auction contract linked yet, so it cannot accept
          bids. You can compose the terms below but nothing will send.
        </p>
      ) : null}
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
              Budget (base units)
            </label>
            <Input
              id="bid-budget"
              data-testid="bid-budget"
              className="mt-1"
              onChange={(e) => setBudget(e.target.value)}
              placeholder="1000000"
              value={budget}
              type="number"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="bid-max-price">
              Max price (Q96)
            </label>
            <Input
              id="bid-max-price"
              data-testid="bid-max-price"
              className="mt-1"
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="2000000000000000000000000"
              value={maxPrice}
              type="number"
            />
          </div>
        </div>
        {clearing !== null ? (
          <p className="text-xs text-black/60 dark:text-white/60">
            Current clearing price: {clearing.toString()} Q96. Your max price
            must be above it.
          </p>
        ) : (
          <p className="text-xs text-black/60 dark:text-white/60">
            Clearing price unavailable right now; the contract still enforces
            "above clearing" when the bid lands.
          </p>
        )}
        {issues.length > 0 ? (
          <ul
            data-testid="bid-issues"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {issues.map((i) => (
              <li key={i.message}>{i.message}</li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div>
          <label className="text-sm font-medium" htmlFor="bid-tx">
            Transaction hash
          </label>
          <Input
            id="bid-tx"
            data-testid="bid-tx"
            className="mt-1"
            onChange={(e) => setTx(e.target.value)}
            placeholder="0x…"
            value={tx}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          data-testid="bid-send"
          disabled={!canSend}
          onClick={() => void sendBid()}
          type="button"
        >
          {sending ? "Sending…" : "Send bid"}
        </Button>
        <Button
          data-testid="bid-record"
          disabled={!canMirror}
          onClick={submit}
          type="button"
        >
          {isPublishing ? "Recording…" : "Record bid"}
        </Button>
      </div>
    </Modal>
  );
}
