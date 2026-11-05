import { type FormEvent, useCallback, useEffect, useState } from "react";

import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { recordSaleCurrency } from "../chain";
import { formatAtomic, formatMoney } from "../lib/amounts";
import { Button } from "@/shared/ui/button";
import {
  GRADUATION_STEP_COPY,
  graduationGate,
  graduationReadinessText,
  graduationStepStatusText,
  stepMarker,
} from "@creaton/core/launchpad/auction-copy.ts";
import { DEFAULT_RESERVE_BPS } from "@creaton/core/launchpad/auctionFlow.ts";
import { GRADUATION_STEPS } from "@creaton/core/launchpad/graduationFlow.ts";
import {
  GRADUATION_TX_HASH_RE,
  graduationTxStore,
} from "@creaton/core/launchpad/graduation-progress.ts";
import type { Launch } from "../models";
import { useGraduationFlow } from "../use-auction-flow";
import { useConnectedWallet } from "../use-connected-wallet";
import { usePublishMirror } from "../use-launches";
import {
  AddressRow,
  FailureNote,
  GateNote,
  StatusLine,
  StepRow,
  WalletStrip,
} from "./account-widgets";
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
  const { state, check, retry: retryFlow } = flow;

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
  const cur = recordSaleCurrency(record);
  // Graduated in this session, or earlier (found by the readiness check): the
  // steps below are then history or irrelevant, and the outcome is what matters.
  const alreadyGraduated = readiness?.status === "already-graduated";
  const canExecute = state.phase === "ready" && gate.ok;
  const retry = flow.retryPlan;

  const moneyLanded = state.graduationTxHash !== null;
  const failureNote =
    state.errorMessage &&
    (state.phase === "mirrorFailed" ||
      state.txHashMissing ||
      (moneyLanded && state.failedStep !== "execute"))
      ? " The graduation itself is complete on the network. Trying again only saves the remaining record and never sends the money again."
      : "";

  // Manual hash recovery (the terminal `supply-hash` state): the founder
  // pastes the confirmed executeGraduation hash (wallet / block explorer) and
  // it is persisted where the flow resumes from it.
  const [hashDraft, setHashDraft] = useState("");
  const [hashError, setHashError] = useState<string | null>(null);
  const submitTxHash = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const txHash = hashDraft.trim();
      if (!GRADUATION_TX_HASH_RE.test(txHash)) {
        setHashError(
          "Enter the full confirmation ID: 0x followed by 64 letters or numbers (0-9, a-f).",
        );
        return;
      }
      setHashError(null);
      // One action = one atomic persist, then resume the receipt mirrors. The
      // hash also rides the retry itself, so a browser that refuses storage
      // (blocked site data) still resumes; only reload-survival is lost.
      try {
        graduationTxStore(record.auction ?? "").save(txHash);
      } catch {
        // Best-effort: the in-memory hash below is what this run binds to.
      }
      retryFlow(txHash);
    },
    [hashDraft, record.auction, retryFlow],
  );

  return (
    <div
      className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="graduation-panel"
    >
      <h3 className="text-sm font-semibold text-black dark:text-white">
        Graduate the launch
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {record.tokenPlan?.mode === "dao"
          ? "Graduating pays out the sale. Once the sale has ended and raised enough, one step moves the money raised and the unsold tokens to the project's money and records it. Anyone can run it; the money can only go there."
          : `Graduating pays out the sale. Once the sale has ended and raised enough, one step moves the money raised and the unsold tokens, sets ${DEFAULT_RESERVE_BPS / 100}% of the raise aside to back the token's price floor, sends the rest to the project's money, and records it. Anyone can run it; the money can only go to those two places.`}
      </p>
      <UnauditedNotice chainId={record.chainId} />
      <WalletStrip testIdPrefix="graduation" wallet={wallet} />
      {state.readiness || state.phase === "checking" ? null : (
        <GateNote gate={gate} testId="graduation-gate" />
      )}

      <StatusLine
        testId="graduation-readiness"
        text={
          state.phase === "checking"
            ? "Checking whether the sale can be paid out…"
            : readiness
              ? graduationReadinessText(readiness)
              : ""
        }
      />
      {readiness ? (
        <details className="mt-1 text-xs text-black/50 dark:text-white/50">
          <summary className="cursor-pointer">Technical detail</summary>
          <p className="mt-1 [overflow-wrap:anywhere]">{readiness.message}</p>
        </details>
      ) : null}

      {flow.result ? (
        <dl
          className="mt-3 divide-y divide-black/10 rounded-lg border border-black/10 px-3 text-sm dark:divide-white/10 dark:border-white/10"
          data-testid="graduation-result"
        >
          {[
            ["Raised", formatMoney(flow.result.currencyRaised, cur)],
            [
              "Paid to the project's money",
              formatMoney(flow.result.treasuryShare, cur),
            ],
            // A project with its own DAO keeps no reserve: the whole raise goes to the treasury.
            ...(flow.result.reserveEscrow > 0n
              ? [
                  [
                    "Set aside for the price floor",
                    formatMoney(flow.result.reserveEscrow, cur),
                  ],
                ]
              : []),
            [
              "Unsold tokens returned to the project",
              formatAtomic(flow.result.unsoldTokens, 18, {
                symbol: "tokens",
                maxFractionDigits: 2,
              }),
            ],
          ].map(([label, value]) => (
            <div
              className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
              key={label}
            >
              <dt className="text-black/60 dark:text-white/60">{label}</dt>
              <dd className="ml-auto text-right font-medium tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ol
        aria-label="Graduation steps"
        className={`mt-3 flex flex-col gap-1 ${alreadyGraduated && state.phase !== "done" ? "hidden" : ""}`}
      >
        {GRADUATION_STEPS.map((step) => {
          const status = state.steps[step.id];
          return (
            <StepRow
              detail={GRADUATION_STEP_COPY[step.id].detail}
              key={step.id}
              label={GRADUATION_STEP_COPY[step.id].label}
              marker={stepMarker(status)}
              status={graduationStepStatusText(status, state.order.length > 0)}
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
            Graduate now
          </Button>
        ) : null}
        {state.phase === "failed" || state.phase === "mirrorFailed" ? (
          retry && retry.kind !== "supply-hash" ? (
            <Button
              aria-busy={flow.busy}
              data-testid="graduation-retry"
              disabled={flow.busy || (retry.kind !== "check" && !gate.ok)}
              onClick={() => flow.retry()}
              size="sm"
              type="button"
              variant="outline"
            >
              {retry.kind === "check"
                ? "Check readiness again"
                : retry.kind === "mirror"
                  ? "Save the record again"
                  : "Try the remaining steps again"}
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

      {retry?.kind === "supply-hash" ? (
        <form
          aria-label="Enter the confirmation ID of the graduation"
          className="mt-2 flex flex-wrap items-center gap-2"
          data-testid="graduation-supply-hash-form"
          onSubmit={submitTxHash}
        >
          <label
            className="text-xs text-black/60 dark:text-white/60"
            htmlFor="graduation-tx-hash"
          >
            Confirmation ID of the graduation
          </label>
          <input
            aria-describedby={
              hashError ? "graduation-tx-hash-error" : undefined
            }
            aria-invalid={hashError ? true : undefined}
            className="min-w-0 flex-1 rounded-md border border-black/20 bg-transparent px-2 py-1 text-xs [overflow-wrap:anywhere] dark:border-white/20"
            data-testid="graduation-tx-hash-input"
            disabled={flow.busy}
            id="graduation-tx-hash"
            onChange={(event) => setHashDraft(event.target.value)}
            placeholder="0x…"
            value={hashDraft}
          />
          <Button
            data-testid="graduation-supply-hash"
            disabled={flow.busy}
            size="sm"
            type="submit"
            variant="outline"
          >
            Save the record
          </Button>
          {hashError ? (
            <p
              className="w-full text-xs text-red-600 dark:text-red-400"
              data-testid="graduation-tx-hash-error"
              id="graduation-tx-hash-error"
              role="alert"
            >
              {hashError}
            </p>
          ) : null}
        </form>
      ) : null}

      <StatusLine
        testId="graduation-status"
        text={
          state.phase === "running"
            ? "Graduation in progress…"
            : state.phase === "done"
              ? "Graduation done and both records saved."
              : ""
        }
      />
      {state.errorMessage ? (
        <FailureNote
          message={`${state.errorMessage}${failureNote}`}
          testId="graduation-failure"
        />
      ) : null}
      {readiness?.executor ? (
        <AddressRow
          copyLabel="Copy payout step address"
          label="Payout step (where the sale's money goes first)"
          value={readiness.executor}
        />
      ) : null}
      {state.graduationTxHash ? (
        <AddressRow
          copyLabel="Copy graduation confirmation ID"
          label="Graduation confirmation ID"
          value={state.graduationTxHash}
        />
      ) : null}
    </div>
  );
}
