/**
 * Escalated reports, for the people who run the server: each report a community's moderators sent on, with who sent
 * it, which community and what it is about, when it was sent, and the actions an operator has (remove the post, ban
 * its author or the reported person, or close it with nothing done). Rendered only once the server has accepted the
 * signed-in person as one of its operators; nobody else is ever shown it.
 */

import { useState } from "react";
import { Ban, Trash2 } from "lucide-react";

import { ReasonDialog } from "@/features/board/ui/ReasonDialog";
import { useUserNames } from "@/features/profiles/use-profiles";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  aboutLine,
  doneLine,
  type EscalatedRow,
  type OperatorAction,
  operatorActions,
  personOf,
} from "../lib/escalatedReports";
import { reportDate } from "../lib/moderationQueue";
import { useEscalatedReports } from "../use-escalated-reports";

const MUTED = "text-2xs text-black/60 dark:text-white/60";
const BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70";

function actionLabel(action: OperatorAction, personName: string): string {
  if (action === "delete") return "Remove it…";
  if (action === "ban") return `Ban ${personName}`;
  return "Close, nothing to do";
}

function Row({
  row,
  busy,
  problems,
  onPerform,
}: {
  row: EscalatedRow;
  busy: boolean;
  problems: string[];
  onPerform: (
    action: OperatorAction,
    reason?: string,
  ) => Promise<string | null>;
}) {
  const { report, words, done } = row;
  const person = personOf(report);
  const nameOf = useUserNames(
    [report.reporterPubkey, person].filter(
      (key): key is string => key !== null,
    ),
  );
  const personName = person ? nameOf(person) : "this member";
  const [confirmingBan, setConfirmingBan] = useState(false);
  const [removing, setRemoving] = useState(false);
  const sentOn = reportDate(report.escalatedAt);

  return (
    <li
      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
      data-testid="escalated-report-row"
    >
      <p className="truncate text-xs font-medium text-black dark:text-white">
        {aboutLine(report)}
      </p>
      <p className={MUTED} data-testid="escalated-report-community">
        In {report.communityHost}
        {sentOn ? ` · sent on ${sentOn}` : ""}
      </p>
      {words ? (
        <p
          className="mt-1 whitespace-pre-wrap break-words text-xs text-black dark:text-white"
          data-testid="escalated-report-words"
        >
          “{words.length > 200 ? `${words.slice(0, 200).trimEnd()}…` : words}”
        </p>
      ) : null}
      {person ? (
        <p className={MUTED}>
          {report.targetKind === "pubkey" ? "Reported person" : "Written by"}{" "}
          {personName}
        </p>
      ) : null}
      <p className={`mt-1 ${MUTED}`} data-testid="escalated-report-reporter">
        Reported by {nameOf(report.reporterPubkey)}
      </p>
      {report.note ? (
        <p className="mt-1 text-2xs text-black/70 dark:text-white/70">
          Why: “{report.note}”
        </p>
      ) : null}
      {done ? (
        <p className={`mt-1 ${MUTED}`} data-testid="escalated-report-done">
          {doneLine(done)}
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {operatorActions(report).map((action) => (
            <button
              aria-label={`${actionLabel(action, personName).replace("…", "")}: escalated ${aboutLine(report)} report`}
              className={BUTTON}
              data-testid={`escalated-${action}`}
              disabled={busy}
              key={action}
              onClick={() => {
                if (action === "delete") setRemoving(true);
                else if (action === "ban") setConfirmingBan(true);
                else void onPerform(action);
              }}
              type="button"
            >
              {action === "delete" ? <Trash2 className="h-3 w-3" /> : null}
              {action === "ban" ? <Ban className="h-3 w-3" /> : null}
              {actionLabel(action, personName)}
            </button>
          ))}
        </div>
      )}
      {problems.map((problem) => (
        <p
          className="pt-1 text-2xs text-red-600 dark:text-red-400"
          data-testid="escalated-action-error"
          key={problem}
          role="alert"
        >
          {problem}
        </p>
      ))}
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel={`Ban ${personName}`}
        description={`${personName} can no longer post in ${report.communityHost}. The report is closed.`}
        onCancel={() => setConfirmingBan(false)}
        onConfirm={() => {
          setConfirmingBan(false);
          void onPerform("ban");
        }}
        open={confirmingBan}
        title={`Ban ${personName}?`}
      />
      {removing ? (
        <ReasonDialog
          confirmLabel="Remove"
          description="It will be removed for everyone and the report closed. Your reason is kept in the server’s records."
          destructive
          onClose={() => setRemoving(false)}
          reasonLabel="Reason (optional)"
          onConfirm={async (reason) => {
            const failed = await onPerform("delete", reason || undefined);
            if (failed !== null) throw new Error(failed);
          }}
          testId="escalated-delete-dialog"
          title="Remove the reported post?"
        />
      ) : null}
    </li>
  );
}

/** The operator's list, for an admin origin the server has accepted this person on. */
export function EscalatedReportsPanel({ origin }: { origin: string }) {
  const { rows, loading, error, acting, errors, perform } =
    useEscalatedReports(origin);

  return (
    <section
      aria-labelledby="escalated-reports-heading"
      className="mb-3 rounded-lg border border-black/10 p-2 dark:border-white/10"
      data-testid="escalated-reports"
    >
      <h3
        className="text-xs font-semibold text-black dark:text-white"
        id="escalated-reports-heading"
      >
        Escalated reports
      </h3>
      <p className={`mb-2 ${MUTED}`}>
        Reports a community’s moderators sent on to you, as someone who runs
        this server.
      </p>
      {error ? (
        <p
          className="pb-2 text-2xs text-red-600 dark:text-red-400"
          data-testid="escalated-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {loading && rows.length === 0 ? (
        <p className={MUTED}>Loading escalated reports…</p>
      ) : rows.length === 0 ? (
        <p className={MUTED} data-testid="escalated-empty">
          Nothing waiting on you.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <Row
              busy={[...acting].some((key) =>
                key.startsWith(`${row.report.id}:`),
              )}
              key={row.report.id}
              onPerform={(action, reason) =>
                perform(row.report, action, reason)
              }
              problems={[...errors.entries()]
                .filter(([key]) => key.startsWith(`${row.report.id}:`))
                .map(([, message]) => message)}
              row={row}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
