import * as React from "react";
import { RefreshCw } from "lucide-react";

import {
  buildClaimExecution,
  buildExitExecution,
  type BidActions,
  type BidStatus,
  type ExitFlowState,
  type ExitPlan,
  type ExitStepId,
  resolveExitPlanAt,
  useExitFlow,
  useMyBids,
  EXIT_STEP_LABELS,
} from "@/features/launchpad/exitHooks";
import type { Launch } from "@/features/launchpad/launchpadModels";
import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import {
  useChainStatusQuery,
  useWalletStatusQuery,
} from "@/features/launchpad/walletHooks";

/** Status labels per contract semantics (see `deriveBidStatus`). */
const STATUS_LABELS: Record<BidStatus, string> = {
  active: "Active",
  outbid: "Outbid",
  ended: "Auction ended",
  exited: "Exited · awaiting claim",
  claimable: "Claimable",
  settled: "Settled",
};

const NO_WALLET_MESSAGE =
  "No wallet is connected. Connect one in the wallet card, then reopen this tab to see your bids.";

function formatBaseUnits(value: bigint): string {
  return new Intl.NumberFormat().format(value);
}

function stepStatusText(state: ExitFlowState, step: ExitStepId): string {
  switch (state.steps[step]) {
    case "done": {
      const receipt = state.receipts[step];
      return receipt ? `Confirmed · ${receipt.txHash.slice(0, 10)}…` : "Done";
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

function exitButtonLabel(plan: ExitPlan): string {
  return plan.kind === "exitPartiallyFilledBid" ? "Exit & refund" : "Exit";
}

function exitPlanNote(plan: ExitPlan): string | null {
  if (plan.kind === "checkpointThenExit") {
    return "Writes the pending checkpoint first, then exits.";
  }
  return null;
}

/**
 * "My bids" — the wallet's onchain bids on this launch with the in-app Exit
 * and Claim money actions (docs/next-gen-launchpad-plan.md: no hash pasting).
 * Actions are gated to exactly what the vendored CCA contract allows
 * (`exitHooks.ts` carries the file:line citations); every failure names its
 * step and a retry sends only the remaining steps. Long operations are
 * transaction sends that wait for onchain confirmation — labeled as such in
 * the live status region.
 */
export function MyBidsPanel({ launch }: { launch: Launch }) {
  const record = launch.record;
  const rpcUrl = getRpcEndpoint(getCachedRelayOrigin());
  const walletQuery = useWalletStatusQuery();
  const chainQuery = useChainStatusQuery(rpcUrl);
  const owner = walletQuery.data?.address ?? null;
  const { load, reload } = useMyBids(rpcUrl, record.auction, owner);
  const flow = useExitFlow();
  const [flowTitle, setFlowTitle] = React.useState<string | null>(null);
  const refreshedAfterDone = React.useRef(false);

  // Refresh the list once when an attempt completes (the reducer's `done` is
  // the only path to new onchain state).
  React.useEffect(() => {
    if (flow.state.phase === "done" && !refreshedAfterDone.current) {
      refreshedAfterDone.current = true;
      reload();
    }
    if (flow.state.phase !== "done") {
      refreshedAfterDone.current = false;
    }
  }, [flow.state.phase, reload]);

  const busy = flow.state.phase === "running";
  const flowArmed = flow.state.order.length > 0;

  const startExit = (bidId: bigint, plan: ExitPlan) => {
    if (!record.auction || !chainQuery.data) return;
    const auction = record.auction;
    const execution = buildExitExecution({
      rpcUrl,
      chainId: chainQuery.data.chainId,
      auction,
      bidId,
      plan,
      resolvePlan: () => resolveExitPlanAt(rpcUrl, auction, bidId),
    });
    setFlowTitle(`Bid #${bidId.toString()}`);
    refreshedAfterDone.current = false;
    void flow.start(execution);
  };

  const startClaim = (bidIds: bigint[]) => {
    if (!record.auction || !chainQuery.data || !owner) return;
    setFlowTitle(
      bidIds.length === 1
        ? `Bid #${bidIds[0].toString()}`
        : `${bidIds.length} bids`,
    );
    refreshedAfterDone.current = false;
    void flow.start(
      buildClaimExecution({
        rpcUrl,
        chainId: chainQuery.data.chainId,
        auction: record.auction,
        owner,
        bidIds,
      }),
    );
  };

  if (!record.auction) {
    return (
      <p className="max-w-3xl text-sm text-muted-foreground">
        Auction not deployed yet.
      </p>
    );
  }

  if (walletQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        Checking wallet…
      </div>
    );
  }

  if (walletQuery.isError || !owner) {
    return (
      <p className="max-w-3xl text-sm text-destructive" role="alert">
        {walletQuery.isError
          ? `Could not read the wallet: ${
              walletQuery.error instanceof Error
                ? walletQuery.error.message
                : "the request failed"
            }.`
          : NO_WALLET_MESSAGE}
      </p>
    );
  }

  const chainMismatch =
    chainQuery.data != null &&
    record.chainId !== null &&
    Number(record.chainId) !== chainQuery.data.chainId;

  const claimableIds =
    load.status === "ready"
      ? load.snapshot.bids
          .filter((entry) => entry.actions.claim.kind === "claim")
          .map((entry) => entry.bidId)
      : [];

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">My bids</h3>
          <div className="flex items-center gap-2">
            {claimableIds.length >= 2 ? (
              <Button
                aria-busy={busy || undefined}
                disabled={busy || chainMismatch}
                onClick={() => startClaim(claimableIds)}
                size="sm"
                type="button"
              >
                Claim all ({claimableIds.length})
              </Button>
            ) : null}
            <button
              aria-label="Refresh bids"
              className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              disabled={load.status === "loading" || busy}
              onClick={reload}
              type="button"
            >
              <RefreshCw
                className={
                  load.status === "loading" ? "h-4 w-4 animate-spin" : "h-4 w-4"
                }
              />
            </button>
          </div>
        </div>
        <p className="mt-1 text-2xs text-muted-foreground">
          Onchain bids from {truncatePubkey(owner)} on this launch. Exit refunds
          the unfilled budget and records the filled share; claim transfers the
          filled tokens after the claim block.
        </p>
        {chainQuery.isError ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            Could not reach the configured RPC endpoint:{" "}
            {chainQuery.error instanceof Error
              ? chainQuery.error.message
              : "the request failed"}
            . Fix it in the wallet card, then refresh.
          </p>
        ) : null}
        {chainMismatch ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            This launch is on chain {record.chainId}, but the wallet reports
            chain {chainQuery.data?.chainId}. Switch networks in the wallet
            card, then refresh.
          </p>
        ) : null}
        <p
          aria-live="polite"
          className="mt-2 min-h-5 text-2xs text-muted-foreground"
          role="status"
        >
          {flowArmed
            ? flow.state.phase === "done"
              ? `Done — ${flowTitle ?? ""} updated onchain. Refreshing the list…`
              : `Sending: ${
                  EXIT_STEP_LABELS[
                    flow.state.order.find(
                      (step) => flow.state.steps[step] === "active",
                    ) ?? flow.state.order[flow.state.order.length - 1]
                  ]
                }… each transaction waits for onchain confirmation.`
            : "Exit and claim each send an onchain transaction and may take ~15 seconds to confirm."}
        </p>
      </section>

      {flowArmed ? (
        <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
          <h3 className="text-sm font-semibold">
            Transaction steps{flowTitle ? ` · ${flowTitle}` : ""}
          </h3>
          <ul
            aria-label="Transaction steps"
            className="mt-2 flex flex-col gap-1.5"
          >
            {flow.state.order.map((step) => (
              <li
                className="flex min-h-6 items-center justify-between gap-2 text-sm"
                key={step}
              >
                <span>{EXIT_STEP_LABELS[step]}</span>
                <span className="text-2xs text-muted-foreground">
                  {stepStatusText(flow.state, step)}
                </span>
              </li>
            ))}
          </ul>
          {flow.state.phase === "failed" && flow.state.errorMessage ? (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {flow.state.errorMessage} Completed steps are kept — retry sends
              only the remaining steps.
            </p>
          ) : null}
          {flow.state.phase === "failed" ? (
            <Button
              aria-busy={busy || undefined}
              className="mt-2"
              disabled={busy}
              onClick={() => void flow.retry()}
              size="sm"
              type="button"
            >
              {busy ? "Retrying…" : "Retry remaining steps"}
            </Button>
          ) : null}
        </section>
      ) : null}

      {load.status === "loading" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading your bids…
        </div>
      ) : null}
      {load.status === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive" role="alert">
            Could not load your bids: {load.message}
          </p>
          <Button onClick={reload} size="sm" type="button" variant="outline">
            Reload
          </Button>
        </div>
      ) : null}
      {load.status === "ready" && load.snapshot.bids.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No onchain bids from this wallet on this launch yet.
        </p>
      ) : null}
      {load.status === "ready" ? (
        <ul aria-label="Your bids" className="flex flex-col gap-2">
          {load.snapshot.bids.map((entry) => (
            <BidRow
              actions={entry.actions}
              amountQ96={entry.bid.amountQ96}
              bidId={entry.bidId}
              busy={busy || chainMismatch}
              key={entry.bidId.toString()}
              onClaim={() => startClaim([entry.bidId])}
              onExit={(plan) => startExit(entry.bidId, plan)}
              tokensFilled={entry.bid.tokensFilled}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BidRow({
  actions,
  amountQ96,
  bidId,
  busy,
  onClaim,
  onExit,
  tokensFilled,
}: {
  actions: BidActions;
  amountQ96: bigint;
  bidId: bigint;
  busy: boolean;
  onClaim: () => void;
  onExit: (plan: ExitPlan) => void;
  tokensFilled: bigint;
}) {
  const canExit =
    actions.exit.kind === "exitBid" ||
    actions.exit.kind === "exitPartiallyFilledBid" ||
    actions.exit.kind === "checkpointThenExit";
  const canClaim = actions.claim.kind === "claim";
  return (
    <li className="min-h-20 rounded-xl border border-border/70 bg-card/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Bid #{bidId.toString()}</span>
            <span className="rounded-full border border-border/70 px-2 py-0.5 text-2xs text-muted-foreground">
              {STATUS_LABELS[actions.status]}
            </span>
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            Budget {formatBaseUnits(amountQ96 >> 96n)} base units
            {tokensFilled > 0n
              ? ` · filled ${formatBaseUnits(tokensFilled)} tokens`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canExit ? (
            <Button
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => onExit(actions.exit)}
              size="sm"
              type="button"
              variant="outline"
            >
              {exitButtonLabel(actions.exit)}
            </Button>
          ) : null}
          {canClaim ? (
            <Button
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={onClaim}
              size="sm"
              type="button"
            >
              Claim
            </Button>
          ) : null}
        </div>
      </div>
      {canExit && exitPlanNote(actions.exit) ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {exitPlanNote(actions.exit)}
        </p>
      ) : null}
      {!canExit && actions.exit.kind === "unavailable" ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {actions.exit.reason}
        </p>
      ) : null}
      {!canClaim && actions.claim.kind === "unavailable" ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {actions.claim.reason}
        </p>
      ) : null}
    </li>
  );
}
