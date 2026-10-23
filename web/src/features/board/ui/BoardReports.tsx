/**
 * The open reports about this board's posts and replies, for its moderators: what was reported, why, and by whom it was
 * written (never who reported it). A moderator can open the thread, remove what was reported with a public reason, close
 * a report about words already gone, or dismiss it, each only where the server would allow it; otherwise the row says who
 * decides instead.
 */

import { useState } from "react";
import { toast } from "sonner";

import { reportTypeLabel } from "@/features/moderation/lib/moderationQueue";

import type { BoardReportRow, BoardReports } from "../use-board-reports";
import { ReasonDialog } from "./ReasonDialog";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Row({
  row,
  reports,
  nameOf,
  onOpenPost,
}: {
  row: BoardReportRow;
  reports: BoardReports;
  nameOf: (pubkey: string) => string;
  onOpenPost: (id: string) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const { report, words, choices } = row;
  const busy = reports.acting.has(report.id);
  const problem = reports.errors.get(report.id);
  const subject = words
    ? `a ${words.what} by ${nameOf(words.author)}`
    : "a post or reply that is no longer on this board";
  const done = (message: string) => (failed: string | null) => {
    if (failed === null) toast.success(message);
  };

  return (
    <li
      className="rounded-lg border px-3 py-2 text-xs"
      data-testid="board-report-row"
    >
      <p>
        <span className="font-medium">
          {reportTypeLabel(report.reportType)}
        </span>{" "}
        · {subject}
        {report.createdAt ? (
          <span className="text-muted-foreground">
            {" "}
            · reported {when(report.createdAt)}
          </span>
        ) : null}
      </p>
      {words?.excerpt ? (
        <p className="mt-0.5 text-muted-foreground">"{words.excerpt}"</p>
      ) : null}
      {report.note ? (
        <p className="mt-0.5">
          <span className="text-muted-foreground">Why: </span>
          {report.note}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {words ? (
          <button
            className="underline"
            data-testid="board-report-open"
            onClick={() => onOpenPost(words.thread)}
            type="button"
          >
            {words.what === "post" ? "Open the post" : "Open the thread"}
          </button>
        ) : null}
        {choices.remove ? (
          <button
            className="text-destructive underline disabled:opacity-50"
            data-testid="board-report-remove"
            disabled={busy}
            onClick={() => setRemoving(true)}
            type="button"
          >
            Remove {words?.what ?? "it"}…
          </button>
        ) : null}
        {choices.close ? (
          <button
            className="underline disabled:opacity-50"
            data-testid="board-report-close"
            disabled={busy}
            onClick={() => void reports.close(row).then(done("Report closed."))}
            type="button"
          >
            Close the report
          </button>
        ) : null}
        {choices.dismiss ? (
          <button
            className="underline disabled:opacity-50"
            data-testid="board-report-dismiss"
            disabled={busy}
            onClick={() =>
              void reports
                .dismiss(row)
                .then(done("Report dismissed. Nothing was removed."))
            }
            type="button"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {choices.leftFor ? (
        <p
          className="mt-1 text-muted-foreground"
          data-testid="board-report-left-for"
        >
          {choices.leftFor}
        </p>
      ) : null}
      {problem ? (
        <p
          className="mt-1 text-destructive"
          data-testid="board-report-error"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {removing && words ? (
        <ReasonDialog
          confirmLabel="Remove"
          description={`This ${words.what} will be removed for everyone on this board and the report closed. ${nameOf(words.author)} is told, and the removal and your reason go in the board's moderation log.`}
          destructive
          onClose={() => setRemoving(false)}
          onConfirm={async (reason) => {
            const failed = await reports.remove(row, reason);
            if (failed !== null) throw new Error(failed);
            toast.success(`Removed, and the report is closed.`);
          }}
          testId="board-report-remove-dialog"
          title={`Remove this ${words.what}?`}
        />
      ) : null}
    </li>
  );
}

export function BoardReportsSection({
  reports,
  nameOf,
  onOpenPost,
}: {
  reports: BoardReports;
  nameOf: (pubkey: string) => string;
  onOpenPost: (id: string) => void;
}) {
  return (
    <div data-testid="board-reports">
      <h3 className="text-sm font-semibold">Reports</h3>
      <p className="text-xs text-muted-foreground">
        Open reports about posts and replies here. You are not told who sent
        them. The community's moderators see every report too, and decide
        anything more than a removal, such as a ban.
      </p>
      {reports.error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {reports.error}{" "}
          <button
            className="underline"
            onClick={() => void reports.refresh()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : reports.loading ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Loading reports…
        </p>
      ) : reports.rows.length === 0 ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="board-reports-empty"
        >
          No open reports.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {reports.rows.map((row) => (
            <Row
              key={row.report.id}
              nameOf={nameOf}
              onOpenPost={onOpenPost}
              reports={reports}
              row={row}
            />
          ))}
        </ul>
      )}
      {reports.paused ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Stopped checking for new reports.{" "}
          <button
            className="underline"
            data-testid="board-reports-refresh"
            onClick={() => void reports.refresh()}
            type="button"
          >
            Check now
          </button>
        </p>
      ) : null}
    </div>
  );
}
