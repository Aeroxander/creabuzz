/**
 * Approvals inbox rows: one list covering budget overruns and workflow
 * requests, with who/what/why detail and Approve/Reject actions. Outcomes
 * render as a status line once resolved; a failed publish keeps the row
 * actionable with an inline retry.
 */

import { Check, X } from "lucide-react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  approvalDetailRows,
  approvalHeadline,
  approvalPreview,
} from "../lib/approvals";
import { useApprovals, type ApprovalItem } from "../use-approvals";

const STATUS_TEXT: Record<ApprovalItem["status"], string | null> = {
  pending: null,
  resolving: "Sending…",
  granted: "Approved",
  denied: "Denied",
};

export function ApprovalsPanel() {
  const { items, resolving, errors, resolve, clearError } = useApprovals();
  const visible = items.slice(0, 10);
  if (visible.length === 0) return null;

  return (
    <div
      className="mb-2 border-b border-black/10 pb-2 dark:border-white/10"
      data-testid="approvals-panel"
    >
      <p className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
        Needs you
      </p>
      {visible.map((item) => {
        const busy =
          resolving.has(item.tokenHash) || item.status === "resolving";
        const decided = item.status === "granted" || item.status === "denied";
        const error = errors.get(item.tokenHash);
        const detailRows = approvalDetailRows(item, (pubkey) =>
          truncatePubkey(pubkey),
        );
        return (
          <div
            className="rounded-lg px-2 py-2"
            data-testid="approval-row"
            key={item.id}
          >
            <p className="text-xs font-medium text-black dark:text-white">
              {approvalHeadline(item)}
            </p>
            <p className="text-2xs text-black/60 dark:text-white/60">
              {approvalPreview(item)}
            </p>
            {detailRows.length > 0 ? (
              <dl className="mt-1 space-y-0.5">
                {detailRows.map((row) => (
                  <div
                    className="flex items-baseline gap-1.5 text-2xs"
                    key={row.label}
                  >
                    <dt className="text-black/60 dark:text-white/60">
                      {row.label}
                    </dt>
                    <dd className="truncate font-medium text-black dark:text-white">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="mt-0.5 text-2xs text-black/60 dark:text-white/60">
              Requested for{" "}
              {item.subjectPubkey
                ? truncatePubkey(item.subjectPubkey)
                : "an agent"}
            </p>
            {error ? (
              <p
                className="mt-1 text-2xs text-red-600 dark:text-red-400"
                data-testid="approval-error"
                role="alert"
              >
                {error} Try again below.
              </p>
            ) : null}
            {decided ? (
              <p
                className="mt-1 text-2xs font-medium text-black/70 dark:text-white/70"
                data-testid="approval-outcome"
              >
                {STATUS_TEXT[item.status]}
              </p>
            ) : (
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  aria-label={`Approve ${approvalHeadline(item)}`}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground disabled:opacity-50"
                  data-testid="approval-approve"
                  disabled={busy}
                  onClick={() => {
                    void resolve(item.tokenHash, true);
                  }}
                  type="button"
                >
                  <Check className="h-3 w-3" />
                  {error ? "Try again" : "Approve"}
                </button>
                <button
                  aria-label={`Reject ${approvalHeadline(item)}`}
                  className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
                  data-testid="approval-reject"
                  disabled={busy}
                  onClick={() => {
                    void resolve(item.tokenHash, false);
                  }}
                  type="button"
                >
                  <X className="h-3 w-3" />
                  Reject
                </button>
                {error ? (
                  <button
                    className="text-2xs text-black/60 underline dark:text-white/60"
                    onClick={() => clearError(item.tokenHash)}
                    type="button"
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            )}
            {busy && !decided ? (
              <p className="mt-1 text-2xs text-black/60 dark:text-white/60">
                Sending…
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
