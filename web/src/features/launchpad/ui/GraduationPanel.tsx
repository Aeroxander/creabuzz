import { useCallback, useEffect } from "react";

import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import {
  graduationGate,
  graduationStepStatusText,
  stepMarker,
} from "../lib/auction-copy";
import { DEFAULT_RESERVE_BPS } from "../lib/auctionFlow";
import { GRADUATION_STEPS } from "../lib/graduationFlow";
import type { Launch } from "../models";
import { useGraduationFlow } from "../use-auction-flow";
import { useConnectedWallet } from "../use-connected-wallet";
import { usePublishMirror } from "../use-launches";
import {
  AddressRow,
  FailureNote,
  GateNote,
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
 * Execute the graduation once the auction has ended and cleared its floor: one
 * atomic call sweeps the raise and the unsold supply, splits the raise between
 * the reserve escrow and the treasury, and records the graduation. Then the
 * `sweep` and `lock` receipts are published, bound to the confirmed
 * transaction, through the same mirror path bids use.
 *
 * The readiness check only reads (the launch's configured RPC), so it runs on
 * open without a wallet. The call itself is permissionless — the money can only
 * go to the treasury and the reserve escrow — so any connected wallet on the
 * right chain may send it.
 */
export function GraduationPanel({ launch }: { launch: Launch }) {
  const { record } = launch;
  const wallet = useConnectedWallet();
  const launchChainId = chainNumber(record.chainId);
  const mirror = usePublishMirror();
  const publishMirror = mirror.mutateAsync;

  const publishReceipt = useCallback(
    (
      _kind: "sweep" | "lock",
      parts: { extraTags: string[][]; content: Record<string, string> },
    ) =>
      publishMirror({
        kind: KIND_LAUNCH_RECEIPT,
        author: record.author,
        launchId: record.id,
        extraTags: parts.extraTags,
        content: parts.content,
      }),
    [publishMirror, record.author, record.id],
  );

  const flow = useGraduationFlow({
    auction: record.auction ?? "",
    executor: null,
    endBlock: record.endBlock,
    wallet: wallet.wallet,
    chainId: launchChainId ?? 0,
    publishReceipt,
  });
  const { state, check } = flow;

  // Read the graduation gates on open, and again if the auction changes.
  useEffect(() => {
    check();
  }, [check]);

  const gate = graduationGate({
    address: wallet.address,
    walletChainId: wallet.chainId,
    launchChainId,
  });
  const readiness = state.readiness;
  const canExecute = state.phase === "ready" && gate.ok;
  const retry = flow.retryPlan;

  const moneyLanded = state.graduationTxHash !== null;
  const failureNote =
    state.errorMessage &&
    (state.phase === "mirrorFailed" ||
      (moneyLanded && state.failedStep !== "execute"))
      ? " The graduation itself is complete onchain. Retrying only publishes the remaining receipt and never sends the money again."
      : "";

  return (
    <div
      className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="graduation-panel"
    >
      <h3 className="text-sm font-semibold text-black dark:text-white">
        Graduate the launch
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Once the auction has ended and raised enough, one transaction sweeps the
        raise and the unsold supply, puts {DEFAULT_RESERVE_BPS / 100}% of the
        raise into the reserve escrow that backs the token&apos;s price floor,
        sends the rest to the treasury, and records the graduation. Anyone can
        send it; the money can only go to those two places.
      </p>
      <UnauditedNotice chainId={record.chainId} />
      <WalletStrip testIdPrefix="graduation" wallet={wallet} />
      {state.readiness || state.phase === "checking" ? null : (
        <GateNote gate={gate} testId="graduation-gate" />
      )}

      <p
        aria-live="polite"
        className="mt-2 text-sm text-black/60 dark:text-white/60"
        data-testid="graduation-readiness"
        role="status"
      >
        {state.phase === "checking"
          ? "Reading the auction's graduation gates…"
          : readiness
            ? readiness.message
            : ""}
      </p>

      <ol aria-label="Graduation steps" className="mt-3 flex flex-col gap-1">
        {GRADUATION_STEPS.map((step) => {
          const status = state.steps[step.id];
          return (
            <StepRow
              detail={step.detail}
              key={step.id}
              label={step.label}
              marker={stepMarker(status)}
              status={graduationStepStatusText(status)}
              testId={`graduation-step-${step.id}`}
            />
          );
        })}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state.phase === "ready" && state.order.length === 0 ? (
          <Button
            aria-busy={flow.busy}
            data-testid="graduation-execute"
            disabled={flow.busy || !canExecute}
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
              data-testid="graduation-retry"
              disabled={flow.busy || (retry.kind !== "check" && !gate.ok)}
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
          ) : null
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
        className="mt-2 min-h-5 text-sm text-black/60 dark:text-white/60"
        data-testid="graduation-status"
        role="status"
      >
        {state.phase === "running"
          ? "Graduation in progress…"
          : state.phase === "done"
            ? "Graduation executed and both receipts published."
            : ""}
      </p>
      {state.errorMessage ? (
        <FailureNote
          message={`${state.errorMessage}${failureNote}`}
          testId="graduation-failure"
        />
      ) : null}
      {readiness?.executor ? (
        <AddressRow
          copyLabel="Copy graduation executor address"
          label="Graduation executor (the auction's funds recipient)"
          value={readiness.executor}
        />
      ) : null}
      {state.graduationTxHash ? (
        <AddressRow
          copyLabel="Copy graduation transaction hash"
          label="Graduation transaction"
          value={state.graduationTxHash}
        />
      ) : null}
    </div>
  );
}
