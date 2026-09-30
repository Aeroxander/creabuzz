/**
 * Moderation queue: reported content with its reporter, status, and the
 * moderator actions for open rows — resolve (delete / time out / ban pair an
 * enforcement with the resolution), dismiss, and escalate. Action
 * affordances render only for moderators; empty, loading, and error states
 * are explicit, and a failed action keeps the row open with an inline retry.
 */

import { useState } from "react";
import { Ban, Clock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  reportStatusLabel,
  reportTargetLabel,
  reportTypeLabel,
  type ModerationReport,
  type ResolutionAction,
} from "../lib/moderationQueue";
import {
  useModerationAccess,
  useModerationQueue,
  type ModerationRow,
} from "../use-moderation-queue";

const ACTION_LABEL: Record<ResolutionAction, string> = {
  delete: "Delete content",
  timeout: "Time out",
  ban: "Ban",
  dismiss: "Dismiss",
  escalate: "Escalate",
};

/** Bounded timeout choices — one of three fixed windows, no free-form input. */
const TIMEOUT_CHOICES: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
];

function Row({
  row,
  onPerform,
}: {
  row: ModerationRow;
  onPerform: (
    report: ModerationReport,
    action: ResolutionAction,
    options?: { expiresAt?: number },
  ) => void;
}) {
  const [pickingTimeout, setPickingTimeout] = useState(false);
  const [confirmingBan, setConfirmingBan] = useState(false);
  const { report, actions, locallyResolved } = row;
  const open = report.status === "open" && !locallyResolved;
  const buttons: ResolutionAction[] = open ? actions : [];

  return (
    <li
      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
      data-testid="moderation-report-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium text-black dark:text-white">
          {reportTypeLabel(report.reportType)} · about{" "}
          {reportTargetLabel(report.targetKind)}
        </p>
        <span className="shrink-0 text-2xs font-medium text-black/70 dark:text-white/70">
          {reportStatusLabel(locallyResolved ? "resolved" : report.status)}
        </span>
      </div>
      <p className="text-2xs text-black/60 dark:text-white/60">
        Reported by {truncatePubkey(report.reporterPubkey)}
        {report.createdAt
          ? ` · ${new Date(report.createdAt).toLocaleString()}`
          : ""}
      </p>
      {report.note ? (
        <p className="mt-1 text-2xs text-black/70 dark:text-white/70">
          “{report.note}”
        </p>
      ) : null}
      {buttons.length > 0 ? (
        <div className="mt-1.5">
          {pickingTimeout ? (
            <div
              className="flex flex-wrap items-center gap-1.5"
              data-testid="timeout-choices"
            >
              <span className="text-2xs text-black/60 dark:text-white/60">
                Time out for
              </span>
              {TIMEOUT_CHOICES.map((choice) => (
                <button
                  className="rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 dark:border-white/10 dark:text-white/70"
                  key={choice.seconds}
                  onClick={() => {
                    setPickingTimeout(false);
                    onPerform(report, "timeout", {
                      expiresAt: Math.floor(Date.now() / 1000) + choice.seconds,
                    });
                  }}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
              <button
                className="text-2xs text-black/60 underline dark:text-white/60"
                onClick={() => setPickingTimeout(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {buttons.map((action) => (
                <button
                  aria-label={`${ACTION_LABEL[action]} — ${reportTypeLabel(report.reportType)} report`}
                  className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
                  data-testid={`moderation-${action}`}
                  key={action}
                  onClick={() => {
                    if (action === "timeout") {
                      setPickingTimeout(true);
                    } else if (action === "ban") {
                      setConfirmingBan(true);
                    } else {
                      onPerform(report, action);
                    }
                  }}
                  type="button"
                >
                  {action === "delete" ? <Trash2 className="h-3 w-3" /> : null}
                  {action === "timeout" ? <Clock className="h-3 w-3" /> : null}
                  {action === "ban" ? <Ban className="h-3 w-3" /> : null}
                  {ACTION_LABEL[action]}
                </button>
              ))}
            </div>
          )}
          <ConfirmDialog
            cancelLabel="Cancel"
            confirmLabel="Ban member"
            description="They can no longer post in this community. You can lift the ban later."
            onCancel={() => setConfirmingBan(false)}
            onConfirm={() => {
              setConfirmingBan(false);
              onPerform(report, "ban");
            }}
            open={confirmingBan}
            title="Ban this member?"
          />
        </div>
      ) : null}
    </li>
  );
}

export function ModerationQueuePanel() {
  const { access, loading: accessLoading } = useModerationAccess();
  const { rows, loading, error, pollPaused, acting, errors, perform, refresh } =
    useModerationQueue();
  const visible = rows.slice(0, 30);
  const moderator = access === "granted";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="moderation-queue-panel"
    >
      <div className="flex items-center justify-between gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-black/60 dark:text-white/60" />
          <h2 className="text-sm font-semibold text-black dark:text-white">
            Moderation queue
          </h2>
          {pollPaused ? (
            <span className="text-2xs text-black/60 dark:text-white/60">
              Auto-refresh paused
            </span>
          ) : null}
        </div>
        <button
          className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 dark:border-white/10 dark:text-white/70"
          data-testid="moderation-refresh"
          onClick={() => {
            void refresh();
          }}
          type="button"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <p
            className="pb-2 text-2xs text-red-600 dark:text-red-400"
            data-testid="moderation-error"
            role="alert"
          >
            {error} Try refreshing.
          </p>
        ) : null}
        {!moderator && !accessLoading && access === "denied" ? (
          <p
            className="py-6 text-center text-2xs text-black/60 dark:text-white/60"
            data-testid="moderation-denied"
          >
            Only community moderators can review reports. Ask an owner or admin
            if you think this is wrong.
          </p>
        ) : loading && visible.length === 0 ? (
          <p className="py-6 text-center text-2xs text-black/60 dark:text-white/60">
            Loading reports…
          </p>
        ) : visible.length === 0 ? (
          <p
            className="py-6 text-center text-2xs text-black/60 dark:text-white/60"
            data-testid="moderation-empty"
          >
            No reports right now.
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((row) => (
              <Row
                key={row.report.id}
                onPerform={(report, action, options) => {
                  void perform(report, action, options);
                }}
                row={row}
              />
            ))}
          </ul>
        )}
        {acting.size > 0 ? (
          <p className="pt-2 text-2xs text-black/60 dark:text-white/60">
            Sending…
          </p>
        ) : null}
        {[...errors.entries()].map(([key, message]) => (
          <p
            className="pt-2 text-2xs text-red-600 dark:text-red-400"
            data-testid="moderation-action-error"
            key={key}
            role="alert"
          >
            {message} The report stays open — use the buttons above to try
            again.
          </p>
        ))}
      </div>
    </div>
  );
}
