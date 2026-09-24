import { useChannelsQuery } from "@/features/channels/hooks";
import { Copy } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  usePublishLaunchMirrorMutation,
  useUpdateLaunchRecordMutation,
  type CreateLaunchInput,
} from "@/features/launchpad/hooks";
import {
  useAuctionDeployFlow,
  useGraduationFlow,
} from "@/features/launchpad/auctionHooks";
import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import {
  AUCTION_DEPLOY_STEPS,
  AUCTION_DEPLOY_STEP_LABELS,
  DEFAULT_RESERVE_BPS,
  deriveAuctionDeployParams,
  retryPlan as auctionRetryPlan,
  type AuctionDeployFailure,
  type AuctionDeployState,
  type AuctionDeployStepState,
  type AuctionPlanInputs,
} from "@/features/launchpad/lib/auctionFlow";
import {
  GRADUATION_STEPS,
  graduationRetryPlan,
  type GraduationStepStatus,
} from "@/features/launchpad/lib/graduationFlow";
import {
  MINT_STEPS,
  mintErrorMessage,
  retryPlan,
  treasuryGate,
  type MintFlowState,
  type MintStepState,
} from "@/features/launchpad/lib/mintFlow";
import { STAGE_LABELS } from "@/features/launchpad/lib/launchpadStatus";
import type { Launch, LaunchStage } from "@/features/launchpad/launchpadModels";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import {
  useEvmChainStatusQuery,
  useTokenDeployFlow,
} from "@/features/launchpad/mintHooks";
import { useWalletStatusQuery } from "@/features/launchpad/walletHooks";
import { CreateLaunchDialog } from "@/features/launchpad/ui/CreateLaunchDialog";
import { Button } from "@/shared/ui/button";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { truncatePubkey } from "@/shared/lib/pubkey";

const STAGE_ORDER: LaunchStage[] = [
  "draft",
  "review",
  "live",
  "funding",
  "graduated",
  "failed",
];

type MintPlanParams = { name: string; symbol: string; supply: string };

function stepMarker(status: MintStepState["status"]): string {
  switch (status) {
    case "running":
      return "…";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "○";
  }
}

function stepStatusText(
  step: MintStepState,
  index: number,
  state: MintFlowState,
): string {
  switch (step.status) {
    case "running":
      return "In progress…";
    case "failed":
      return "Failed";
    case "done":
      if (step.txHash) return `Confirmed ${truncatePubkey(step.txHash)}`;
      return index === 0 && state.tokenAlreadyDeployed
        ? "Done (already deployed)"
        : "Done";
    default:
      return "Pending";
  }
}

/** The one-line progress narration for the live region. */
function statusLine(state: MintFlowState): string {
  switch (state.phase) {
    case "preparing":
      return "Computing the token address (router fee + CREATE2 preflight)…";
    case "running": {
      const index = state.steps.findIndex((s) => s.status === "running");
      const current = index === -1 ? 0 : index;
      const slowNote =
        current === 0
          ? " This step creates the token and its pool and is usually the slowest."
          : "";
      return `Deploying token (step ${current + 1}/3 — ${MINT_STEPS[current].label})…${slowNote}`;
    }
    case "linking":
      return "All 3 transactions confirmed. Updating the launch record…";
    case "success":
      return "Token deployed and linked to this launch.";
    default:
      return "";
  }
}

/**
 * Rule-1 failure copy: exactly which step and why, the tx hash, what
 * completed, the token address where known, and what retry will do.
 */
function failureMessage(state: MintFlowState): string | null {
  const failure = state.failure;
  if (!failure) return null;
  if (failure.stage === "prepare") {
    const labels: Record<string, string> = {
      plan: "Launch plan check",
      treasury: "Treasury check",
      "infrastructure-fee": "Router fee read",
      "token-address": "Token address computation",
      "token-state": "Token verification",
    };
    const label = labels[failure.check ?? ""] ?? "Preflight";
    return `Deploy stopped before any transaction — ${label} failed: ${failure.reason}`;
  }
  const tokenNote = state.tokenAddress
    ? ` Token address: ${state.tokenAddress}.`
    : "";
  if (failure.stage === "link") {
    return `All 3 transactions confirmed — the token is deployed at ${state.tokenAddress ?? "(address unavailable)"} — but updating the launch record failed: ${failure.reason} The onchain deploy is complete; use "Retry record update" below to link it.`;
  }
  const index = failure.stepIndex ?? 0;
  const step = MINT_STEPS[index];
  const outcome =
    failure.outcome === "reverted"
      ? "reverted onchain"
      : "failed without a receipt — it may or may not have been broadcast";
  const txNote = failure.txHash ? ` Transaction: ${failure.txHash}.` : "";
  const completed = state.steps
    .map((s, i) => (s.status === "done" ? MINT_STEPS[i].label : null))
    .filter((label) => label !== null);
  const completedNote =
    completed.length > 0
      ? ` Completed: ${completed.join(", ")}.`
      : " No steps completed.";
  const retryNote =
    failure.outcome === "unknown" && index === 0
      ? ' "Retry remaining steps" first checks whether the token already exists onchain, then resumes from there.'
      : ' "Retry remaining steps" re-runs from this step.';
  return `Step ${index + 1}/3 (${step.label}) ${outcome}: ${failure.reason}${txNote}${completedNote}${tokenNote}${retryNote}`;
}

/**
 * One-click token deploy: preflight (wallet, RPC/chain, treasury) → the two
 * view preconditions → the 3 sequential onchain calls → record update. No CLI
 * and no pasted addresses anywhere in the path.
 *
 * Partial failures keep every completed step on screen, name the exact step
 * and transaction that failed, and offer a retry that resumes there. There is
 * deliberately no CLI fallback note: the forge script's only behavior this
 * flow doesn't reproduce is its `deployments/apptoken-latest.json` tooling
 * artifact — the record's `token` tag is the handoff this app uses.
 */
function TokenDeployPanel({
  launch,
  plan,
  onLink,
}: {
  launch: Launch;
  plan: MintPlanParams;
  onLink: (input: { token: string; treasury: string }) => Promise<unknown>;
}) {
  const rpcUrl = React.useMemo(
    () => getRpcEndpoint(getCachedRelayOrigin()),
    [],
  );
  const walletQuery = useWalletStatusQuery();
  const wallet =
    walletQuery.data?.hasWallet && walletQuery.data.address
      ? walletQuery.data.address
      : null;
  const chainQuery = useEvmChainStatusQuery(rpcUrl, wallet !== null);
  const flow = useTokenDeployFlow({
    plan,
    deployer: wallet ?? "",
    recordTreasury: launch.record.treasury,
    rpcUrl,
    chainId: chainQuery.data?.chainId ?? 0,
    onLink,
  });
  const { state } = flow;
  const tokenAddress = state.tokenAddress;

  const gate = treasuryGate(wallet ?? "", launch.record.treasury);
  const recordChain = launch.record.chainId;
  const liveChainId = chainQuery.data?.chainId;
  const chainMismatch =
    recordChain != null &&
    liveChainId !== undefined &&
    String(liveChainId) !== recordChain;

  let gateMessage: React.ReactNode = null;
  if (walletQuery.isPending) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground" role="status">
        Checking wallet…
      </p>
    );
  } else if (walletQuery.isError) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        Couldn&apos;t read wallet status:{" "}
        {mintErrorMessage(walletQuery.error ?? "unknown error")}
      </p>
    );
  } else if (!wallet) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground">
        Create a wallet first — the Wallet card creates one, and this deploy
        signs with it. No CLI needed.
      </p>
    );
  } else if (chainQuery.isPending) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground" role="status">
        Checking the chain at {rpcUrl}…
      </p>
    );
  } else if (chainQuery.isError) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        The chain at {rpcUrl} is unreachable:{" "}
        {mintErrorMessage(chainQuery.error ?? "unknown error")}. Check the RPC
        endpoint, then try again.
      </p>
    );
  } else if (chainMismatch) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        This launch targets chain {recordChain}, but {rpcUrl} is chain{" "}
        {liveChainId}. Point the RPC endpoint at chain {recordChain} to deploy.
      </p>
    );
  } else if (!gate.ok) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        {gate.detail}
      </p>
    );
  }
  const gatePassed = gateMessage === null;

  const retry = retryPlan(state);
  const failure = failureMessage(state);

  return (
    <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
      <h3 className="text-sm font-semibold">Deploy {plan.symbol}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {plan.supply} {plan.symbol} ({plan.name}) · reserve-backed apptoken,
        deployed onchain from this app in three transactions.
      </p>
      {gateMessage}
      {gatePassed ? (
        <ol aria-label="Deploy steps" className="mt-2 flex flex-col gap-0.5">
          {MINT_STEPS.map((step, index) => {
            const stepState = state.steps[index];
            return (
              <li
                className="grid min-h-5 grid-cols-[1.25rem_1fr] items-baseline gap-x-2 text-2xs"
                key={step.id}
              >
                <span aria-hidden className="text-muted-foreground">
                  {stepMarker(stepState.status)}
                </span>
                <span>
                  <span className="font-medium">{step.label}</span>{" "}
                  <span className="text-muted-foreground">{step.detail}</span>{" "}
                  <span>{stepStatusText(stepState, index, state)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {gatePassed ? (
        <div className="mt-2 flex items-center gap-2">
          {state.phase === "paused" ? (
            retry ? (
              <Button
                aria-busy={flow.busy}
                disabled={flow.busy}
                onClick={flow.retry}
                size="sm"
                type="button"
                variant="outline"
              >
                {retry.kind === "record"
                  ? "Retry record update"
                  : "Retry remaining steps"}
              </Button>
            ) : (
              <p className="text-2xs text-muted-foreground">
                Retry isn&apos;t available here — run the deploy again.
              </p>
            )
          ) : state.phase === "success" ? null : (
            <Button
              aria-busy={flow.busy}
              disabled={flow.busy}
              onClick={flow.start}
              size="sm"
              type="button"
            >
              Deploy token
            </Button>
          )}
        </div>
      ) : null}
      <p
        aria-live="polite"
        className="mt-2 min-h-4 text-2xs text-muted-foreground"
        role="status"
      >
        {statusLine(state)}
      </p>
      {failure ? (
        <p className="mt-1 text-2xs text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
      {tokenAddress &&
      (state.phase === "success" || state.phase === "paused") ? (
        <div className="mt-2 flex min-w-0 items-start gap-1.5 rounded-lg bg-muted px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-medium text-muted-foreground">
              Token address
            </div>
            <div className="break-all font-mono text-xs">{tokenAddress}</div>
          </div>
          <Button
            aria-label="Copy token address"
            onClick={() =>
              copyTextToClipboard(tokenAddress, "Token address copied")
            }
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Copy />
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** A copyable deployed-address row (one label owner per copy button). */
function AddressRow({
  label,
  address,
  copyLabel,
}: {
  label: string;
  address: string;
  copyLabel: string;
}) {
  return (
    <div className="mt-2 flex min-w-0 items-start gap-1.5 rounded-lg bg-muted px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-2xs font-medium text-muted-foreground">
          {label}
        </div>
        <div className="break-all font-mono text-xs">{address}</div>
      </div>
      <Button
        aria-label={copyLabel}
        onClick={() => copyTextToClipboard(address, `${label} copied`)}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Copy />
      </Button>
    </div>
  );
}

function deployStepMarker(
  status: AuctionDeployStepState["status"] | GraduationStepStatus,
): string {
  switch (status) {
    case "running":
    case "active":
      return "…";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "–";
    default:
      return "○";
  }
}

function deployStepStatusText(step: AuctionDeployStepState): string {
  switch (step.status) {
    case "running":
      return "In progress…";
    case "failed":
      return "Failed";
    case "skipped":
      return "Not part of this launch (community track).";
    case "done":
      if (step.alreadyDeployed) return "Done (already deployed)";
      return step.txHash ? `Confirmed ${truncatePubkey(step.txHash)}` : "Done";
    default:
      return "Pending";
  }
}

/** Rule-1 failure copy: exact step, tx, outcome, completed work, retry action. */
function auctionFailureMessage(state: AuctionDeployState): string | null {
  const failure: AuctionDeployFailure | null = state.failure;
  if (!failure) return null;
  if (failure.stage === "prepare") {
    return `Deploy stopped before any transaction — ${failure.check ?? "preflight"} check failed: ${failure.reason}`;
  }
  if (failure.stage === "link") {
    const auctionAddress = state.auctionAddress ?? "(address unavailable)";
    return `All deploy transactions confirmed — the auction is at ${auctionAddress} — but updating the launch record failed: ${failure.reason} The onchain deploy is complete; use "Retry record update" below to link it.`;
  }
  const stepId = failure.step ?? "auction";
  const label =
    AUCTION_DEPLOY_STEP_LABELS[
      stepId as keyof typeof AUCTION_DEPLOY_STEP_LABELS
    ] ?? stepId;
  const outcome =
    failure.outcome === "reverted"
      ? "reverted onchain"
      : failure.outcome === "unknown"
        ? "failed without a receipt — it may or may not have been broadcast"
        : "failed before broadcast";
  const txNote = failure.txHash ? ` Transaction: ${failure.txHash}.` : "";
  const completed = AUCTION_DEPLOY_STEPS.filter(
    (s) => state.steps[s.id]?.status === "done",
  ).map((s) => s.label);
  const completedNote =
    completed.length > 0
      ? ` Completed: ${completed.join(", ")}.`
      : " No steps completed.";
  const retryNote =
    failure.outcome === "unknown"
      ? ' "Retry remaining steps" first checks for code at the predicted address, then resumes from there.'
      : ' "Retry remaining steps" re-runs from this step with re-derived inputs.';
  return `${label} ${outcome}: ${failure.reason}${txNote}${completedNote}${retryNote}`;
}

/**
 * Deploy the auction onchain from this app: optional AllowlistHook (curated
 * track) → GraduationExecutor (the auction's funds/tokens recipient at deploy
 * time — GraduationExecutor.sol:77-91) → the CCA auction via the factory's
 * CREATE2 `create` → record link (the `auction` tag). No CLI, no pasted
 * addresses. `AuctionLauncher.registerLaunch` is deliberately not sent: it is
 * optional (the factory is the deploy path — AuctionLauncher.sol:5-9) and no
 * launcher address is pinned in the record.
 */
function AuctionDeployPanel({
  launch,
  onLink,
}: {
  launch: Launch;
  onLink: (input: { auction: string }) => Promise<unknown>;
}) {
  const { record } = launch;
  const rpcUrl = React.useMemo(
    () => getRpcEndpoint(getCachedRelayOrigin()),
    [],
  );
  const walletQuery = useWalletStatusQuery();
  const wallet =
    walletQuery.data?.hasWallet && walletQuery.data.address
      ? walletQuery.data.address
      : null;
  const chainQuery = useEvmChainStatusQuery(rpcUrl, wallet !== null);
  const plan: AuctionPlanInputs = {
    token: record.token ?? "",
    tokenSupply: record.tokenPlan?.supply ?? "",
    currency: record.currency,
    floorPrice: record.floorPrice ?? "",
    tickSpacing: record.tickSpacing ?? "",
    requiredRaised: record.requiredRaised ?? "",
    startBlock: record.startBlock,
    endBlock: record.endBlock,
    claimBlock: record.claimBlock,
    treasury: record.treasury ?? "",
    admission: record.admission,
  };
  const flow = useAuctionDeployFlow({
    plan,
    deployer: wallet ?? "",
    rpcUrl,
    chainId: chainQuery.data?.chainId ?? 0,
    onLink,
  });
  const { state } = flow;

  const recordChain = record.chainId;
  const liveChainId = chainQuery.data?.chainId;
  const chainMismatch =
    recordChain != null &&
    liveChainId !== undefined &&
    String(liveChainId) !== recordChain;

  let planProblem: string | null = null;
  try {
    deriveAuctionDeployParams(plan);
  } catch (error) {
    planProblem = mintErrorMessage(error);
  }

  let gateMessage: React.ReactNode = null;
  if (walletQuery.isPending) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground" role="status">
        Checking wallet…
      </p>
    );
  } else if (walletQuery.isError) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        Couldn&apos;t read wallet status:{" "}
        {mintErrorMessage(walletQuery.error ?? "unknown error")}
      </p>
    );
  } else if (!wallet) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground">
        Create a wallet first — the Wallet card creates one, and this deploy
        signs with it. No CLI needed.
      </p>
    );
  } else if (chainQuery.isPending) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground" role="status">
        Checking the chain at {rpcUrl}…
      </p>
    );
  } else if (chainQuery.isError) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        The chain at {rpcUrl} is unreachable:{" "}
        {mintErrorMessage(chainQuery.error ?? "unknown error")}. Check the RPC
        endpoint, then try again.
      </p>
    );
  } else if (chainMismatch) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        This launch targets chain {recordChain}, but {rpcUrl} is chain{" "}
        {liveChainId}. Point the RPC endpoint at chain {recordChain} to deploy.
      </p>
    );
  } else if (planProblem) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        {planProblem}
      </p>
    );
  }
  const gatePassed = gateMessage === null;

  const retry = auctionRetryPlan(state);
  const failure = auctionFailureMessage(state);
  const addresses: Array<{
    label: string;
    value: string | null;
    copyLabel: string;
  }> = [
    {
      label: "Bid gate (AllowlistHook)",
      value: state.steps.hook.address,
      copyLabel: "Copy bid gate address",
    },
    {
      label: "Graduation executor",
      value: state.steps.executor.address,
      copyLabel: "Copy graduation executor address",
    },
    {
      label: "Auction",
      value: state.auctionAddress ?? state.steps.auction.address,
      copyLabel: "Copy auction address",
    },
  ];

  return (
    <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
      <h3 className="text-sm font-semibold">Deploy auction</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {record.admission === "curated"
          ? "Curated track: deploys the AllowlistHook bid gate, the GraduationExecutor, and the continuous-clearing auction (factory CREATE2)."
          : "Community track: deploys the GraduationExecutor and the continuous-clearing auction (factory CREATE2). No bid hook."}{" "}
        The GraduationExecutor deploys first — it must be the auction&apos;s
        funds and tokens recipient from day one (GraduationExecutor.sol:77-91).
      </p>
      {gateMessage}
      {gatePassed ? (
        <ol
          aria-label="Auction deploy steps"
          className="mt-2 flex flex-col gap-0.5"
        >
          {AUCTION_DEPLOY_STEPS.map((step) => {
            const stepState = state.steps[step.id];
            return (
              <li
                className="grid min-h-5 grid-cols-[1.25rem_1fr] items-baseline gap-x-2 text-2xs"
                key={step.id}
              >
                <span aria-hidden className="text-muted-foreground">
                  {deployStepMarker(stepState.status)}
                </span>
                <span>
                  <span className="font-medium">{step.label}</span>{" "}
                  <span className="text-muted-foreground">{step.detail}</span>{" "}
                  <span>{deployStepStatusText(stepState)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {gatePassed ? (
        <div className="mt-2 flex items-center gap-2">
          {state.phase === "paused" ? (
            retry ? (
              <Button
                aria-busy={flow.busy}
                disabled={flow.busy}
                onClick={flow.retry}
                size="sm"
                type="button"
                variant="outline"
              >
                {retry.kind === "record"
                  ? "Retry record update"
                  : "Retry remaining steps"}
              </Button>
            ) : (
              <p className="text-2xs text-muted-foreground">
                Retry isn&apos;t available here — run the deploy again.
              </p>
            )
          ) : state.phase === "success" ? null : (
            <Button
              aria-busy={flow.busy}
              disabled={flow.busy}
              onClick={flow.start}
              size="sm"
              type="button"
            >
              Deploy auction
            </Button>
          )}
        </div>
      ) : null}
      <p
        aria-live="polite"
        className="mt-2 min-h-4 text-2xs text-muted-foreground"
        role="status"
      >
        {state.phase === "preparing"
          ? "Validating the sale parameters and the deploy-address predictions…"
          : state.phase === "linking"
            ? "All deploy transactions confirmed. Updating the launch record…"
            : state.phase === "success"
              ? "Auction deployed and linked to this launch."
              : ""}
      </p>
      {failure ? (
        <p className="mt-1 text-2xs text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
      {state.phase === "success" || state.phase === "paused"
        ? addresses
            .filter((a) => a.value)
            .map((a) => (
              <AddressRow
                address={a.value ?? ""}
                copyLabel={a.copyLabel}
                key={a.label}
                label={a.label}
              />
            ))
        : null}
    </section>
  );
}

/**
 * Execute the graduation handoff: one atomic `executor.executeGraduation(auction)`
 * call (sweep + split + record — GraduationExecutor.sol:77-129), then the
 * 47005 `sweep`/`lock` receipts bound to the confirmed tx hash via the same
 * mirror publish path the bids use. Readiness is the contract's own gating,
 * read via `evm_call`; the GraduationExecutor address is recovered from the
 * auction's `fundsRecipient()` (the record has no field for it).
 */
function GraduationPanel({ launch }: { launch: Launch }) {
  const { record } = launch;
  const rpcUrl = React.useMemo(
    () => getRpcEndpoint(getCachedRelayOrigin()),
    [],
  );
  const walletQuery = useWalletStatusQuery();
  const wallet =
    walletQuery.data?.hasWallet && walletQuery.data.address
      ? walletQuery.data.address
      : null;
  const chainQuery = useEvmChainStatusQuery(rpcUrl, wallet !== null);
  const mirrorMutation = usePublishLaunchMirrorMutation();
  const publishReceipt = React.useCallback(
    (
      _kind: "sweep" | "lock",
      parts: { extraTags: string[][]; content: Record<string, string> },
    ) =>
      mirrorMutation.mutateAsync({
        kind: KIND_LAUNCH_RECEIPT,
        author: record.author,
        launchId: record.id,
        extraTags: parts.extraTags,
        content: parts.content,
      }),
    [mirrorMutation, record.author, record.id],
  );
  const flow = useGraduationFlow({
    auction: record.auction ?? "",
    executor: null,
    endBlock: record.endBlock,
    rpcUrl,
    chainId: chainQuery.data?.chainId ?? 0,
    publishReceipt,
  });
  const { state } = flow;
  React.useEffect(() => {
    if (wallet && !chainQuery.isError) flow.check();
    // Re-check whenever the wallet/endpoint identity changes (stable inputs).
  }, [flow.check, wallet, chainQuery.isError]);

  const retry = flow.retryPlan ?? graduationRetryPlan(state);
  const readiness = state.readiness;
  const executor = readiness?.executor ?? null;
  const canExecute = state.phase === "ready" && wallet !== null;

  const failure = state.errorMessage;
  const moneyLanded = state.graduationTxHash !== null;
  const failureNote = failure
    ? state.phase === "mirrorFailed" ||
      (moneyLanded && state.failedStep !== "execute")
      ? " The graduation itself is complete onchain — retry publishes the remaining receipt(s) only and never re-sends the money action."
      : ""
    : "";

  return (
    <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
      <h3 className="text-sm font-semibold">Execute graduation</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        One atomic call sweeps the raise and the unsold supply, splits{" "}
        {DEFAULT_RESERVE_BPS / 100}% into the reserve escrow (the TokenMaster
        floor) and the rest into the treasury, then records the graduation
        (GraduationExecutor.sol:77-129).
      </p>
      {walletQuery.isPending || chainQuery.isPending ? (
        <p className="mt-2 text-2xs text-muted-foreground" role="status">
          Checking wallet and chain…
        </p>
      ) : walletQuery.isError ? (
        <p className="mt-2 text-2xs text-destructive" role="alert">
          Couldn&apos;t read wallet status:{" "}
          {mintErrorMessage(walletQuery.error ?? "unknown error")}
        </p>
      ) : chainQuery.isError ? (
        <p className="mt-2 text-2xs text-destructive" role="alert">
          The chain at {rpcUrl} is unreachable:{" "}
          {mintErrorMessage(chainQuery.error ?? "unknown error")}
        </p>
      ) : !wallet ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          Create a wallet first — the Wallet card creates one, and this call
          signs with it.
        </p>
      ) : null}
      <p
        aria-live="polite"
        className="mt-2 text-2xs text-muted-foreground"
        role="status"
      >
        {state.phase === "checking"
          ? "Reading the auction's graduation gates…"
          : readiness
            ? readiness.message
            : ""}
      </p>
      <ol aria-label="Graduation steps" className="mt-2 flex flex-col gap-0.5">
        {GRADUATION_STEPS.map((step) => {
          const stepState = state.steps[step.id];
          return (
            <li
              className="grid min-h-5 grid-cols-[1.25rem_1fr] items-baseline gap-x-2 text-2xs"
              key={step.id}
            >
              <span aria-hidden className="text-muted-foreground">
                {deployStepMarker(stepState)}
              </span>
              <span>
                <span className="font-medium">{step.label}</span>{" "}
                <span className="text-muted-foreground">{step.detail}</span>{" "}
                <span>
                  {stepState === "active"
                    ? "In progress…"
                    : stepState === "done"
                      ? "Done"
                      : stepState === "failed"
                        ? "Failed"
                        : stepState === "skipped"
                          ? "Not planned"
                          : "Pending"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex items-center gap-2">
        {canExecute && state.order.length === 0 ? (
          <Button
            aria-busy={flow.busy}
            disabled={flow.busy}
            onClick={flow.start}
            size="sm"
            type="button"
          >
            Execute graduation
          </Button>
        ) : null}
        {state.phase === "failed" || state.phase === "mirrorFailed" ? (
          retry ? (
            <Button
              aria-busy={flow.busy}
              disabled={flow.busy}
              onClick={flow.retry}
              size="sm"
              type="button"
              variant="outline"
            >
              {retry.kind === "check"
                ? "Re-check readiness"
                : retry.kind === "mirror"
                  ? "Retry receipt publish"
                  : "Retry remaining steps"}
            </Button>
          ) : (
            <p className="text-2xs text-muted-foreground">
              Retry isn&apos;t available here.
            </p>
          )
        ) : null}
        <Button
          disabled={flow.busy}
          onClick={flow.check}
          size="sm"
          type="button"
          variant="ghost"
        >
          Re-check
        </Button>
      </div>
      <p
        aria-live="polite"
        className="mt-2 min-h-4 text-2xs text-muted-foreground"
        role="status"
      >
        {state.phase === "running"
          ? "Graduation in progress…"
          : state.phase === "done"
            ? "Graduation executed and both receipts published."
            : ""}
      </p>
      {failure ? (
        <p className="mt-1 text-2xs text-destructive" role="alert">
          {failure}
          {failureNote}
        </p>
      ) : null}
      {executor ? (
        <AddressRow
          address={executor}
          copyLabel="Copy graduation executor address"
          label="Graduation executor (from the auction's fundsRecipient)"
        />
      ) : null}
      {state.graduationTxHash ? (
        <AddressRow
          address={state.graduationTxHash}
          copyLabel="Copy graduation transaction hash"
          label="Graduation transaction"
        />
      ) : null}
    </section>
  );
}

/**
 * Founder workspace: terms, community links, stage machine, danger zone.
 * One user action = one atomic persist — each control publishes exactly one
 * signed record republish; nothing here fans out silently.
 */
export function LaunchManagePanel({
  launch,
  isDeleting,
  onDelete,
}: {
  launch: Launch;
  isDeleting: boolean;
  onDelete: () => Promise<void>;
}) {
  const updateMutation = useUpdateLaunchRecordMutation();
  const channelsQuery = useChannelsQuery();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const { record } = launch;

  const toInput = React.useCallback(
    (overrides: Partial<CreateLaunchInput> = {}): CreateLaunchInput => ({
      id: record.id,
      name: record.name,
      pitch: record.pitch,
      stage: record.stage,
      chainId: record.chainId ?? "11155111",
      currency: record.currency ?? "",
      floorPrice: record.floorPrice ?? "",
      tickSpacing: record.tickSpacing ?? "",
      requiredRaised: record.requiredRaised ?? "",
      auction: record.auction ?? "",
      token: record.token ?? "",
      treasury: record.treasury ?? "",
      admission: record.admission,
      channels: record.channels,
      ...overrides,
    }),
    [record],
  );

  const handleSave = React.useCallback(
    async (input: CreateLaunchInput) => {
      try {
        await updateMutation.mutateAsync(input);
        toast.success("Launch updated.");
        setEditOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Saving failed.");
      }
    },
    [updateMutation],
  );

  // The deploy flow needs the publish error to PROPAGATE (its partial-failure
  // state machine reports it and offers a record-update retry), so it calls
  // the mutation directly instead of the toast-and-swallow handleSave.
  const linkDeployedToken = React.useCallback(
    (input: { token: string; treasury: string }) =>
      updateMutation.mutateAsync(
        toInput({ token: input.token, treasury: input.treasury }),
      ),
    [toInput, updateMutation],
  );

  // Same contract for the auction deploy: the `auction` tag write propagates
  // its error into the flow's partial-failure state (never toast-swallowed).
  const linkDeployedAuction = React.useCallback(
    (input: { auction: string }) =>
      updateMutation.mutateAsync(toInput({ auction: input.auction })),
    [toInput, updateMutation],
  );

  const linked = new Set(record.channels);
  const toggleChannel = (channelId: string) => {
    const next = linked.has(channelId)
      ? record.channels.filter((c) => c !== channelId)
      : [...record.channels, channelId];
    void handleSave(toInput({ channels: next }));
  };

  const advanceStage = (stage: LaunchStage) => {
    void handleSave(toInput({ stage }));
  };

  const stageIndex = STAGE_ORDER.indexOf(record.stage);
  const nextStage =
    stageIndex >= 0 && stageIndex < STAGE_ORDER.length - 1
      ? STAGE_ORDER[stageIndex + 1]
      : null;

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3">
      <p className="text-2xs text-muted-foreground">
        Operator and founder actions — edit terms, link community channels,
        deploy the token and auction, and execute the graduation. Sends run from
        the operator wallet; bidder money actions (bid, exit, claim) happen on
        the web app.
      </p>
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Terms</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Stage: {STAGE_LABELS[record.stage]} · {record.admission} track · chain{" "}
          {record.chainId ?? "undeployed"}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            onClick={() => setEditOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Edit terms
          </Button>
          {nextStage ? (
            <Button
              disabled={updateMutation.isPending}
              onClick={() => advanceStage(nextStage)}
              size="sm"
              type="button"
              variant="outline"
            >
              Advance to {STAGE_LABELS[nextStage]}
            </Button>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Community channels</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Announcements and discussion live in the community. Link channels so
          investors find them from this launch.
        </p>
        {channelsQuery.isLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Loading channels…
          </p>
        ) : (channelsQuery.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No joined channels in this community yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {(channelsQuery.data ?? []).map((channel) => {
              const on = linked.has(channel.id);
              return (
                <li key={channel.id}>
                  <button
                    aria-pressed={on}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => toggleChannel(channel.id)}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className={`flex h-4 w-4 items-center justify-center rounded border text-2xs ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="font-medium">#{channel.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {launch.record.tokenPlan && !launch.record.token ? (
        <TokenDeployPanel
          launch={launch}
          onLink={linkDeployedToken}
          plan={launch.record.tokenPlan}
        />
      ) : null}

      {launch.record.tokenPlan &&
      launch.record.token &&
      !launch.record.auction ? (
        <AuctionDeployPanel launch={launch} onLink={linkDeployedAuction} />
      ) : null}

      {launch.record.auction ? <GraduationPanel launch={launch} /> : null}

      <section className="rounded-2xl border border-destructive/30 px-4 py-3">
        <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Removes the launch from the directory. Onchain state is untouched —
          deletion only hides the card.
        </p>
        {confirmDelete ? (
          <div className="mt-2 flex gap-2">
            <Button
              disabled={isDeleting}
              onClick={() => void onDelete()}
              size="sm"
              type="button"
              variant="destructive"
            >
              {isDeleting ? "Removing…" : "Confirm removal"}
            </Button>
            <Button
              onClick={() => setConfirmDelete(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              Keep
            </Button>
          </div>
        ) : (
          <Button
            className="mt-2"
            onClick={() => setConfirmDelete(true)}
            size="sm"
            type="button"
            variant="destructive"
          >
            Remove launch
          </Button>
        )}
      </section>

      <CreateLaunchDialog
        initial={toInput()}
        isCreating={updateMutation.isPending}
        onCreate={handleSave}
        onOpenChange={setEditOpen}
        open={editOpen}
      />
    </div>
  );
}
