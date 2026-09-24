import * as React from "react";
import { Copy } from "lucide-react";

import {
  buildBidExecution,
  BID_STEP_LABELS,
  type BidStepId,
  evmChainStatus,
  evmWalletStatus,
  readPermit2UnderlyingAllowance,
  useBidFlow,
  type BidFlowState,
} from "@/features/launchpad/bidHooks";
import { usePublishLaunchMirrorMutation } from "@/features/launchpad/hooks";
import type { LaunchRecord } from "@/features/launchpad/launchpadModels";
import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import { ZERO_ADDRESS } from "@/features/launchpad/lib/evmCalls";
import {
  composeBidPlan,
  parseBaseUnits,
  type BidIssue,
} from "@/features/launchpad/lib/bidMath";
import { KIND_LAUNCH_BID } from "@/shared/constants/kinds";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

/** The Permit2 approve deadline the web flow uses: now + 3600s. */
const PERMIT2_DEADLINE_SECONDS = 3600n;

const NO_WALLET_MESSAGE =
  "No wallet is connected. Connect one in the wallet card, then re-check.";

type PreflightState =
  | { status: "checking" }
  | { status: "blocked"; message: string }
  | { status: "ready"; wallet: string; chainId: number; rpcUrl: string };

type Terms =
  | { ok: false; message: string }
  | {
      ok: true;
      auction: string;
      currency: string;
      floorPriceQ96: bigint;
      tickSpacingQ96: bigint;
    };

function stepStatusText(state: BidFlowState, step: BidStepId): string {
  switch (state.steps[step]) {
    case "done": {
      const receipt = state.receipts[step];
      return receipt
        ? `Confirmed · ${receipt.txHash.slice(0, 10)}…`
        : "Published";
    }
    case "active":
      return "Sending…";
    case "failed":
      return "Failed";
    case "pending":
      return "Waiting";
    case "skipped":
      return "Not needed";
  }
}

function TxHashRow({ txHash }: { txHash: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="text-muted-foreground">Transaction</span>
      <button
        aria-label={`Copy transaction hash ${txHash}`}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-2xs hover:bg-muted"
        onClick={() => void copyTextToClipboard(txHash)}
        title="Copy transaction hash"
        type="button"
      >
        <span className="truncate">{txHash.slice(0, 18)}…</span>
        <Copy className="h-3 w-3 shrink-0" />
      </button>
    </div>
  );
}

/**
 * Investor flow, fully in-app (docs/next-gen-launchpad-plan.md §Phase A1): the
 * dialog sends the real CCA `submitBid` sequence through the app's wallet
 * backend — underlying approve / Permit2 approve as needed — and publishes the
 * kind-47002 feed mirror AUTOMATICALLY once the `submitBid` receipt confirms,
 * with the tx hash bound. There is no paste-the-hash field anywhere: the chain
 * is the ledger, the mirror is the record.
 *
 * Partial failures name the failed step (underlying approve / permit2 approve
 * / submitBid / mirror publish), keep completed steps visible, and retry only
 * the remainder. If the bid lands but the mirror publish fails, the retry is
 * mirror-only — the money action is never re-sent.
 */
export function RecordBidDialog({
  onOpenChange,
  open,
  launchName,
  record,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  launchName: string;
  record: LaunchRecord;
}) {
  const [bucket, setBucket] = React.useState("bucket-0");
  const [budget, setBudget] = React.useState("");
  const [maxPrice, setMaxPrice] = React.useState("");
  const [showAllErrors, setShowAllErrors] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [preparing, setPreparing] = React.useState(false);
  const [preflight, setPreflight] = React.useState<PreflightState | null>(null);
  const busyRef = React.useRef(false);
  const mirrorMutation = usePublishLaunchMirrorMutation();
  const {
    state: bidState,
    start: startBid,
    retry: retryBid,
    reset: resetBid,
  } = useBidFlow();

  const resetFlow = resetBid;
  React.useEffect(() => {
    if (open) {
      setBucket("bucket-0");
      setBudget("");
      setMaxPrice("");
      setShowAllErrors(false);
      setActionError(null);
      resetFlow();
    }
  }, [open, resetFlow]);

  // Auction terms gate: without a linked contract or recorded terms nothing
  // can send — say so instead of silently disabling the action.
  const terms = React.useMemo<Terms>(() => {
    const floorPriceQ96 = parseBaseUnits(record.floorPrice);
    const tickSpacingQ96 = parseBaseUnits(record.tickSpacing);
    if (!record.auction) {
      return {
        ok: false,
        message:
          "This launch has no auction contract linked yet, so it cannot accept bids.",
      };
    }
    if (!record.currency) {
      return {
        ok: false,
        message:
          "This launch has no bid currency recorded, so it cannot accept bids.",
      };
    }
    if (floorPriceQ96 === null || tickSpacingQ96 === null) {
      return {
        ok: false,
        message:
          "This launch has no auction terms recorded (floor price and tick spacing), so it cannot accept bids.",
      };
    }
    return {
      ok: true,
      auction: record.auction,
      currency: record.currency,
      floorPriceQ96,
      tickSpacingQ96,
    };
  }, [record.auction, record.currency, record.floorPrice, record.tickSpacing]);

  // Preflight: wallet exists + RPC/chain ok. Every async continuation is
  // fenced by a generation counter so a stale read can never recache state
  // (Review-Proven Rule 2); the effect cleanup invalidates in-flight reads on
  // close/unmount, and "Re-check" reuses the same fenced path.
  const preflightGenerationRef = React.useRef(0);
  const checkPreflight = React.useCallback(async () => {
    if (!terms.ok) {
      setPreflight(null);
      return;
    }
    preflightGenerationRef.current += 1;
    const generation = preflightGenerationRef.current;
    const stale = () => preflightGenerationRef.current !== generation;
    setPreflight({ status: "checking" });
    try {
      const wallet = await evmWalletStatus();
      if (stale()) return;
      if (!wallet.hasWallet || !wallet.address) {
        setPreflight({ status: "blocked", message: NO_WALLET_MESSAGE });
        return;
      }
      const rpcUrl = getRpcEndpoint(getCachedRelayOrigin());
      const { chainId } = await evmChainStatus(rpcUrl);
      if (stale()) return;
      if (record.chainId !== null && Number(record.chainId) !== chainId) {
        setPreflight({
          status: "blocked",
          message: `This launch is on chain ${record.chainId}, but the wallet reports chain ${chainId}. Switch networks in the wallet card, then re-check.`,
        });
        return;
      }
      setPreflight({
        status: "ready",
        wallet: wallet.address,
        chainId,
        rpcUrl,
      });
    } catch (err) {
      if (stale()) return;
      setPreflight({
        status: "blocked",
        message: `Could not reach the wallet or the chain: ${
          err instanceof Error ? err.message : "the request failed"
        }. Check the RPC endpoint, then re-check.`,
      });
    }
  }, [terms, record.chainId]);

  React.useEffect(() => {
    if (!open) {
      setPreflight(null);
      return;
    }
    void checkPreflight();
    return () => {
      // Invalidate in-flight reads so a stale result can't write after close.
      preflightGenerationRef.current += 1;
    };
  }, [open, checkPreflight]);

  // Input validation via lib/bidMath.ts — tick-snapped max price, amount
  // bounds — surfaced as inline field errors.
  const composed = React.useMemo(() => {
    if (!terms.ok || preflight?.status !== "ready") return null;
    return composeBidPlan({
      budget,
      maxPrice,
      owner: preflight.wallet,
      floorPriceQ96: terms.floorPriceQ96,
      tickSpacingQ96: terms.tickSpacingQ96,
      clearingPriceQ96: null,
      supply: null,
    });
  }, [budget, maxPrice, terms, preflight]);

  const issueFor = (field: "amount" | "maxPrice"): string | null => {
    const issue: BidIssue | undefined = composed?.issues.find(
      (i) => i.field === field && i.severity === "error",
    );
    return issue ? issue.message : null;
  };
  const budgetError =
    budget.trim() !== "" || showAllErrors ? issueFor("amount") : null;
  const priceError =
    maxPrice.trim() !== "" || showAllErrors ? issueFor("maxPrice") : null;
  const formBlocked = composed
    ? composed.issues.some((i) => i.severity === "error")
    : true;

  const flowActive = bidState.phase === "running";
  const isBusy =
    flowActive ||
    preparing ||
    preflight?.status === "checking" ||
    mirrorMutation.isPending;
  // Once an attempt is armed the inputs are its committed terms; closing and
  // reopening the dialog starts fresh.
  const committed = bidState.order.length > 0;

  const submit = async () => {
    if (busyRef.current) return;
    setShowAllErrors(true);
    setActionError(null);
    if (!terms.ok || preflight?.status !== "ready" || !composed?.plan) return;
    if (composed.issues.some((i) => i.severity === "error")) return;
    busyRef.current = true;
    setPreparing(true);
    try {
      // Underlying ERC-20 → Permit2 allowance: only a first-time bidder needs
      // the extra approve step (the web flow omits this check entirely).
      let needsUnderlyingAllowance = false;
      const isNative =
        terms.currency.toLowerCase() === ZERO_ADDRESS.toLowerCase();
      if (!isNative) {
        try {
          const allowance = await readPermit2UnderlyingAllowance(
            preflight.rpcUrl,
            terms.currency,
            preflight.wallet,
          );
          needsUnderlyingAllowance = allowance < composed.plan.amount;
        } catch (err) {
          setActionError(
            `Allowance check failed — ${
              err instanceof Error ? err.message : "the read failed"
            }. Nothing was sent.`,
          );
          return;
        }
      }
      const execution = buildBidExecution({
        rpcUrl: preflight.rpcUrl,
        chainId: preflight.chainId,
        auction: terms.auction,
        currency: terms.currency,
        plan: composed.plan,
        needsUnderlyingAllowance,
        permit2Deadline:
          BigInt(Math.floor(Date.now() / 1000)) + PERMIT2_DEADLINE_SECONDS,
        // The kind-47002 mirror, published automatically on confirmed receipt
        // with the hash bound. Content shape reuses the existing mirror path
        // exactly (`usePublishLaunchMirrorMutation`, the same `{ budget,
        // maxPrice, tx }` content `LaunchDetailScreen` published by hand).
        publishMirror: async (txHash: string) => {
          await mirrorMutation.mutateAsync({
            kind: KIND_LAUNCH_BID,
            author: record.author,
            launchId: record.id,
            bucket: bucket.trim() || "bucket-0",
            content: {
              budget: budget.trim() || undefined,
              maxPrice: maxPrice.trim() || undefined,
              tx: txHash,
            },
          });
        },
      });
      await startBid(execution);
    } finally {
      setPreparing(false);
      busyRef.current = false;
    }
  };

  const retry = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionError(null);
    try {
      await retryBid();
    } finally {
      busyRef.current = false;
    }
  };

  const activeStep = bidState.order.find(
    (step) => bidState.steps[step] === "active",
  );
  const statusLine =
    preflight?.status === "checking"
      ? "Checking wallet and network…"
      : preparing
        ? "Checking token allowance…"
        : flowActive && activeStep
          ? `Sending: ${BID_STEP_LABELS[activeStep]}…`
          : bidState.phase === "done"
            ? "Bid placed · mirrored"
            : !terms.ok
              ? ""
              : preflight?.status === "ready" && formBlocked
                ? "Enter a valid budget and max price to place the bid."
                : "Your bid is sent onchain, then mirrored automatically.";

  const canSubmit =
    terms.ok &&
    preflight?.status === "ready" &&
    composed?.plan != null &&
    !formBlocked;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && isBusy) return;
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
            Your bid is a submitBid transaction sent from this app through your
            connected wallet. When it confirms onchain, the bid is mirrored to
            the launch feed automatically. The chain is the ledger.
          </p>
          {!terms.ok ? (
            <p className="text-sm text-destructive" role="alert">
              {terms.message}
            </p>
          ) : null}
          {preflight?.status === "blocked" ? (
            <p className="text-sm text-destructive" role="alert">
              {preflight.message}
            </p>
          ) : null}
          {preflight?.status === "ready" ? (
            <p className="font-mono text-2xs text-muted-foreground">
              Wallet {truncatePubkey(preflight.wallet)} · chain{" "}
              {preflight.chainId}
            </p>
          ) : null}
          <div>
            <label className="text-sm font-medium" htmlFor="bid-bucket">
              Bucket
            </label>
            <span className="mt-1 block">
              <Input
                id="bid-bucket"
                disabled={committed}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="bucket-0"
                value={bucket}
              />
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium" htmlFor="bid-budget">
                Budget (base units)
              </label>
              <span className="mt-1 block">
                <Input
                  id="bid-budget"
                  aria-describedby={
                    budgetError ? "bid-budget-error" : undefined
                  }
                  aria-invalid={budgetError ? true : undefined}
                  disabled={committed}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="1000000"
                  value={budget}
                />
              </span>
              {budgetError ? (
                <p
                  className="mt-1 text-sm text-destructive"
                  id="bid-budget-error"
                >
                  {budgetError}
                </p>
              ) : null}
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="bid-max-price">
                Max price (Q96)
              </label>
              <span className="mt-1 block">
                <Input
                  id="bid-max-price"
                  aria-describedby={
                    priceError ? "bid-max-price-error" : undefined
                  }
                  aria-invalid={priceError ? true : undefined}
                  disabled={committed}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="2000000"
                  value={maxPrice}
                />
              </span>
              {priceError ? (
                <p
                  className="mt-1 text-sm text-destructive"
                  id="bid-max-price-error"
                >
                  {priceError}
                </p>
              ) : null}
            </div>
          </div>
          {bidState.order.length > 0 ? (
            <ul aria-label="Bid steps" className="flex flex-col gap-1.5">
              {bidState.order.map((step) => (
                <li
                  className="flex min-h-6 items-center justify-between gap-2 text-sm"
                  key={step}
                >
                  <span>{BID_STEP_LABELS[step]}</span>
                  <span className="text-2xs text-muted-foreground">
                    {stepStatusText(bidState, step)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {bidState.bidTxHash ? (
            <TxHashRow txHash={bidState.bidTxHash} />
          ) : null}
          {bidState.phase === "failed" && bidState.errorMessage ? (
            <p className="text-sm text-destructive" role="alert">
              {bidState.errorMessage} Completed steps are kept — retry sends
              only the remaining steps.
            </p>
          ) : null}
          {bidState.phase === "mirrorFailed" ? (
            <p className="text-sm text-destructive" role="alert">
              Bid placed onchain, mirror failed — retry mirror.{" "}
              {bidState.errorMessage}
            </p>
          ) : null}
          {actionError ? (
            <p className="text-sm text-destructive" role="alert">
              {actionError}
            </p>
          ) : null}
          <p
            aria-live="polite"
            className={
              bidState.phase === "done"
                ? "min-h-5 text-sm font-medium"
                : "min-h-5 text-2xs text-muted-foreground"
            }
            role="status"
          >
            {statusLine}
          </p>
        </div>
        <DialogFooter>
          {preflight?.status === "blocked" ? (
            <Button
              onClick={() => void checkPreflight()}
              type="button"
              variant="outline"
            >
              Re-check
            </Button>
          ) : null}
          {bidState.phase === "failed" ? (
            <Button
              aria-busy={isBusy || undefined}
              disabled={isBusy}
              onClick={() => void retry()}
              type="button"
            >
              {isBusy ? "Retrying…" : "Retry remaining steps"}
            </Button>
          ) : null}
          {bidState.phase === "mirrorFailed" ? (
            <Button
              aria-busy={isBusy || undefined}
              disabled={isBusy}
              onClick={() => void retry()}
              type="button"
            >
              {isBusy ? "Retrying…" : "Retry mirror"}
            </Button>
          ) : null}
          {bidState.phase === "done" ? (
            <Button onClick={() => onOpenChange(false)} type="button">
              Done
            </Button>
          ) : null}
          {bidState.phase === "idle" || bidState.phase === "running" ? (
            <Button
              aria-busy={isBusy || undefined}
              disabled={bidState.phase === "running" || !canSubmit || isBusy}
              onClick={() => void submit()}
              type="button"
            >
              {preparing
                ? "Checking allowance…"
                : flowActive
                  ? "Placing bid…"
                  : "Place bid"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
