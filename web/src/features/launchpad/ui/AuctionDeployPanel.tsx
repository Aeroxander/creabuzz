import { useMemo } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { isMainnetChain, mainnetEnabled } from "../chain";
import {
  AUCTION_STEP_COPY,
  auctionFailureMessage,
  deployGate,
  deployStepStatusText,
  stepMarker,
} from "../lib/auction-copy";
import {
  AUCTION_DEPLOY_STEPS,
  auctionErrorMessage,
  deriveAuctionDeployParams,
  retryPlan,
  type AuctionPlanInputs,
} from "../lib/auctionFlow";
import type { Launch } from "../models";
import { useAuctionDeployFlow } from "../use-auction-flow";
import { useConnectedWallet } from "../use-connected-wallet";
import {
  AddressRow,
  FailureNote,
  GateNote,
  StatusLine,
  StepRow,
  WalletStrip,
} from "./auction-widgets";
import { UnauditedNotice } from "./UnauditedNotice";

function chainNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Deploy the auction from the browser: bid gate (curated track only) →
 * graduation executor → the auction itself → lock the gate to it → fund it →
 * open bidding → bind the executor to it → save the auction address to the
 * launch record. Wallet only: the executor and gate are created with a plain
 * `CREATE` and their addresses predicted from the wallet's transaction count,
 * which a passkey smart account cannot do.
 *
 * Every send is gated first (`deployGate`): the treasury wallet, on the
 * launch's chain, with sale terms that pass the parameter gate — the failures
 * it prevents would otherwise spend gas and stall at the last step.
 */
export function AuctionDeployPanel({
  launch,
  onLink,
}: {
  launch: Launch;
  onLink: (input: { auction: string }) => Promise<unknown>;
}) {
  const { record } = launch;
  const wallet = useConnectedWallet();
  const launchChainId = chainNumber(record.chainId);

  const plan = useMemo<AuctionPlanInputs>(
    () => ({
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
    }),
    [record],
  );

  const planProblem = useMemo(() => {
    try {
      deriveAuctionDeployParams(plan);
      return null;
    } catch (error) {
      return auctionErrorMessage(error);
    }
  }, [plan]);

  const flow = useAuctionDeployFlow({
    plan,
    wallet: wallet.wallet,
    chainId: launchChainId ?? 0,
    onLink,
  });
  const { state } = flow;

  const gate = deployGate({
    mainnetBlocked: isMainnetChain(record.chainId) && !mainnetEnabled(),
    planProblem,
    address: wallet.address,
    walletChainId: wallet.chainId,
    launchChainId,
    treasury: record.treasury,
  });
  const retry = retryPlan(state);
  const failure = auctionFailureMessage(state);
  const short = (hash: string) => truncatePubkey(hash);

  // An address is shown before its contract exists (it is predicted from the
  // wallet's transaction count), so anything not confirmed yet says so: a bare
  // "Bid gate 0x…" after a declined transaction would claim a contract that was
  // never deployed.
  const addressRow = (
    stepId: "hook" | "executor" | "auction",
    value: string | null,
    copyLabel: string,
  ) => ({
    label: `${AUCTION_STEP_COPY[stepId].label}${
      state.steps[stepId].status === "done" ? "" : " (expected address)"
    }`,
    value,
    copyLabel,
  });
  const addresses = [
    addressRow("hook", state.steps.hook.address, "Copy bid gate address"),
    addressRow(
      "executor",
      state.steps.executor.address,
      "Copy graduation executor address",
    ),
    addressRow(
      "auction",
      state.auctionAddress ?? state.steps.auction.address,
      "Copy auction address",
    ),
  ];

  return (
    <div
      className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="auction-deploy-panel"
    >
      <h3 className="text-sm font-semibold text-black dark:text-white">
        Deploy the auction
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {record.admission === "curated"
          ? "Curated track: deploys the bid gate, the graduation executor and the auction."
          : "Community track: deploys the graduation executor and the auction. There is no bid gate."}{" "}
        Then it moves the whole sale supply into the auction, opens bidding and
        links the auction to this launch. You sign each step in your wallet, as
        the treasury.
      </p>
      <UnauditedNotice chainId={record.chainId} />
      <WalletStrip testIdPrefix="auction" wallet={wallet} />
      <GateNote gate={gate} testId="auction-gate" />

      <ol
        aria-label="Auction deploy steps"
        className="mt-3 flex flex-col gap-1"
      >
        {AUCTION_DEPLOY_STEPS.map((step) => {
          const stepState = state.steps[step.id];
          return (
            <StepRow
              detail={AUCTION_STEP_COPY[step.id].detail}
              key={step.id}
              label={AUCTION_STEP_COPY[step.id].label}
              marker={stepMarker(stepState.status)}
              status={deployStepStatusText(stepState, short)}
              testId={`auction-step-${step.id}`}
            />
          );
        })}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state.phase === "paused" ? (
          retry ? (
            <Button
              aria-busy={flow.busy}
              data-testid="auction-retry"
              disabled={flow.busy || !gate.ok}
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
            <p className="text-sm text-black/60 dark:text-white/60">
              Retry isn&apos;t available here. Reload the page and run the
              deploy again; steps that already landed are detected.
            </p>
          )
        ) : state.phase === "success" ? null : (
          <Button
            aria-busy={flow.busy}
            data-testid="auction-deploy"
            disabled={flow.busy || !gate.ok}
            onClick={flow.start}
            size="sm"
            type="button"
          >
            {flow.busy ? "Deploying…" : "Deploy auction"}
          </Button>
        )}
      </div>

      <StatusLine
        testId="auction-status"
        text={
          state.phase === "preparing"
            ? "Checking the sale terms and predicting the contract addresses…"
            : state.phase === "linking"
              ? "Every deploy transaction confirmed. Saving the auction to this launch…"
              : state.phase === "success"
                ? "Auction deployed and linked to this launch."
                : ""
        }
      />
      {failure ? (
        <FailureNote message={failure} testId="auction-failure" />
      ) : null}
      {state.phase === "success" || state.phase === "paused"
        ? addresses
            .filter((a) => a.value)
            .map((a) => (
              <AddressRow
                copyLabel={a.copyLabel}
                key={a.label}
                label={a.label}
                value={a.value ?? ""}
              />
            ))
        : null}
    </div>
  );
}
