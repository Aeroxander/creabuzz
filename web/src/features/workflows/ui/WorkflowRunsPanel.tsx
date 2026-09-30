/**
 * Workflow run list: one row per run with its steps, plain status language,
 * and the action affordances the current user actually holds — approve /
 * reject on pending approvals addressed to them, and a one-click retry on
 * failed runs. Empty, loading, and error states are explicit; a failed
 * publish keeps the row actionable so the buttons are the recovery path.
 */

import { RefreshCw, RotateCcw, Check, X } from "lucide-react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  failureText,
  runApprovalRows,
  runStatusLabel,
  runStepRows,
} from "../lib/workflowRuns";
import { useWorkflowRuns, type WorkflowRunItem } from "../use-workflow-runs";

const APPROVAL_STATUS_TEXT: Record<string, string> = {
  granted: "Approved",
  denied: "Denied",
  expired: "Expired",
};

function RunRow({
  item,
  busyTokens,
  tokenErrors,
  myPendingTokens,
  locallyResolvedTokens,
  onApprove,
  onRetry,
  retrying,
  retryError,
}: {
  item: WorkflowRunItem;
  busyTokens: ReadonlySet<string>;
  tokenErrors: ReadonlyMap<string, string>;
  myPendingTokens: ReadonlySet<string>;
  locallyResolvedTokens: ReadonlySet<string>;
  onApprove: (tokenHash: string, approved: boolean) => void;
  onRetry: () => void;
  retrying: boolean;
  retryError: string | null;
}) {
  const { run, workflow, approvals } = item;
  const steps = runStepRows(run);
  const failed = run.status === "failed";
  const approvalRows = runApprovalRows(
    approvals,
    myPendingTokens,
    locallyResolvedTokens,
  );
  return (
    <li
      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
      data-testid="workflow-run-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium text-black dark:text-white">
          {workflow.name}
        </p>
        <span className="shrink-0 text-2xs font-medium text-black/70 dark:text-white/70">
          {runStatusLabel(run.status)}
        </span>
      </div>
      <p className="text-2xs text-black/60 dark:text-white/60">
        {new Date(run.createdAt * 1000).toLocaleString()}
      </p>
      {steps.length > 0 ? (
        <ol className="mt-1 space-y-0.5" data-testid="workflow-run-steps">
          {steps.map((step) => (
            <li
              className="flex items-baseline gap-1.5 text-2xs"
              key={step.stepId}
            >
              <span className="truncate text-black/70 dark:text-white/70">
                {step.stepId}
              </span>
              <span className="shrink-0 text-black/50 dark:text-white/50">
                {step.label}
              </span>
              {step.error ? (
                <span className="truncate text-red-600 dark:text-red-400">
                  {step.error}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {failed ? (
        <div className="mt-1">
          <p
            className="text-2xs text-red-600 dark:text-red-400"
            data-testid="workflow-run-failure"
            role="alert"
          >
            {failureText(run)} You can start a new run below.
          </p>
          {retryError ? (
            <p className="text-2xs text-red-600 dark:text-red-400" role="alert">
              {retryError}
            </p>
          ) : null}
          <button
            className="mt-1 inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
            data-testid="workflow-run-retry"
            disabled={retrying}
            onClick={onRetry}
            type="button"
          >
            <RotateCcw className="h-3 w-3" />
            {retrying ? "Starting…" : "Run again"}
          </button>
        </div>
      ) : null}
      {approvalRows.map(({ approval, canDecide }) => {
        const busy = busyTokens.has(approval.approvalRef);
        const error = tokenErrors.get(approval.approvalRef);
        return (
          <div
            className="mt-1.5 border-t border-black/10 pt-1.5 dark:border-white/10"
            data-testid="workflow-run-approval"
            key={approval.approvalRef}
          >
            <p className="text-2xs text-black/70 dark:text-white/70">
              Step {approval.stepIndex + 1} is waiting for approval.
            </p>
            {error ? (
              <p
                className="text-2xs text-red-600 dark:text-red-400"
                role="alert"
              >
                {error} Try again below.
              </p>
            ) : null}
            {canDecide ? (
              <div className="mt-1 flex items-center gap-1.5">
                <button
                  aria-label="Approve this step"
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground disabled:opacity-50"
                  data-testid="run-approve"
                  disabled={busy}
                  onClick={() => onApprove(approval.approvalRef, true)}
                  type="button"
                >
                  <Check className="h-3 w-3" />
                  {error ? "Try again" : "Approve"}
                </button>
                <button
                  aria-label="Reject this step"
                  className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
                  data-testid="run-reject"
                  disabled={busy}
                  onClick={() => onApprove(approval.approvalRef, false)}
                  type="button"
                >
                  <X className="h-3 w-3" />
                  Reject
                </button>
              </div>
            ) : approval.status !== "pending" ? (
              <p className="text-2xs text-black/60 dark:text-white/60">
                {APPROVAL_STATUS_TEXT[approval.status] ?? "Closed"}
                {approval.approverPubkey
                  ? ` by ${truncatePubkey(approval.approverPubkey)}`
                  : ""}
                .
              </p>
            ) : (
              <p className="text-2xs text-black/60 dark:text-white/60">
                Waiting on {approval.approverSpec || "the approver"}.
              </p>
            )}
          </div>
        );
      })}
    </li>
  );
}

export function WorkflowRunsPanel() {
  const {
    items,
    loading,
    error,
    acting,
    errors,
    pollPaused,
    myPendingTokens,
    locallyResolvedTokens,
    approve,
    retryRun,
    refresh,
  } = useWorkflowRuns();
  const visible = items.slice(0, 20);

  return (
    <div data-testid="workflow-runs-panel">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <p className="text-2xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          {pollPaused ? "Auto-refresh paused" : "Recent runs"}
        </p>
        <button
          className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 dark:border-white/10 dark:text-white/70"
          data-testid="workflow-runs-refresh"
          onClick={() => {
            void refresh();
          }}
          type="button"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
      {error ? (
        <p
          className="px-1 pb-2 text-2xs text-red-600 dark:text-red-400"
          data-testid="workflow-runs-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {loading && visible.length === 0 ? (
        <p className="px-1 py-4 text-center text-2xs text-black/60 dark:text-white/60">
          Loading runs…
        </p>
      ) : visible.length === 0 ? (
        <p
          className="px-1 py-4 text-center text-2xs text-black/60 dark:text-white/60"
          data-testid="workflow-runs-empty"
        >
          No runs yet. When a workflow runs, it shows up here.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((item) => (
            <RunRow
              busyTokens={acting}
              item={item}
              key={item.run.id}
              locallyResolvedTokens={locallyResolvedTokens}
              myPendingTokens={myPendingTokens}
              onApprove={(tokenHash, approved) => {
                void approve(tokenHash, approved);
              }}
              onRetry={() => {
                void retryRun(item.run.id, item.workflow.id);
              }}
              retryError={errors.get(item.run.id) ?? null}
              retrying={acting.has(item.run.id)}
              tokenErrors={errors}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
