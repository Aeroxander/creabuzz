/**
 * Moderation queue: each report with what it is about (the reported words and
 * who wrote them, or the reported person, with a link to see it in place), who
 * reported it, its status, and the moderator actions for open rows — resolve
 * (remove / mute everywhere (a server time out) / ban pair an enforcement with the resolution), dismiss,
 * and escalate. All, open or escalated reports, a page at a time. Action
 * affordances render only for moderators; empty, loading, and error states
 * are explicit, and a failed action keeps the row open with an inline retry.
 */

import { useState } from "react";
import { Ban, Clock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import { ReasonDialog } from "@/features/board/ui/ReasonDialog";
import { useUserNames } from "@/features/profiles/use-profiles";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  isHomePostReport,
  reportDate,
  reportStatusLabel,
  reportTypeLabel,
  type ResolutionAction,
} from "../lib/moderationQueue";
import { QUEUE_FILTERS, removedNoun } from "../lib/queueRow";
import {
  useModerationAccess,
  useModerationQueue,
  type ModerationRow,
} from "../use-moderation-queue";

/** The board's Moderate menu says "Remove post…"; the queue uses the same words. */
function actionLabel(action: ResolutionAction, row: ModerationRow): string {
  switch (action) {
    case "delete":
      return `Remove ${removedNoun(row.subject)}…`;
    // The board's own mute covers one board; this one covers the whole community, and says so.
    case "timeout":
      return "Mute everywhere…";
    case "ban":
      return "Ban";
    case "dismiss":
      return "Dismiss";
    case "escalate":
      return "Escalate";
  }
}

/** Bounded timeout choices — one of three fixed windows, no free-form input. */
const TIMEOUT_CHOICES: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
];

const LINK =
  "font-medium text-black underline underline-offset-2 dark:text-white";

/** What the report is about: the reported words and who wrote them, the reported person, or why neither is shown. */
function Subject({
  row,
  nameOf,
}: {
  row: ModerationRow;
  nameOf: (pubkey: string) => string;
}) {
  const { subject } = row;
  if (subject.type === "words") {
    const author = nameOf(subject.author);
    return (
      <>
        <p
          className="mt-1 whitespace-pre-wrap break-words text-xs text-black dark:text-white"
          data-testid="moderation-report-words"
        >
          {subject.excerpt
            ? `“${subject.excerpt}”`
            : "(no words, only a picture or a file)"}
        </p>
        <p className="text-2xs text-black/60 dark:text-white/60">
          Written by{" "}
          <a
            className={LINK}
            data-testid="moderation-report-author"
            href={`/u/${subject.author}`}
          >
            {author}
          </a>{" "}
          ·{" "}
          <a
            aria-label={`${subject.linkLabel} by ${author}`}
            className={LINK}
            data-testid="moderation-report-link"
            href={subject.href}
          >
            {subject.linkLabel}
          </a>
        </p>
      </>
    );
  }
  if (subject.type === "person") {
    return (
      <p className="mt-1 text-xs text-black dark:text-white">
        Reported person:{" "}
        <a
          className={LINK}
          data-testid="moderation-report-person"
          href={subject.href}
        >
          {nameOf(subject.person)}
        </a>
      </p>
    );
  }
  if (subject.type === "gone") {
    return (
      <p
        className="mt-1 text-2xs text-black/60 dark:text-white/60"
        data-testid="moderation-report-gone"
      >
        The reported words aren’t here any more. They may have been removed or
        deleted.
      </p>
    );
  }
  if (subject.type === "notFound") {
    return (
      <p
        className="mt-1 text-2xs text-black/60 dark:text-white/60"
        data-testid="moderation-report-not-found"
      >
        Couldn’t find the reported words. They may have been removed, or be in a
        room or board you aren’t in.
      </p>
    );
  }
  if (subject.type === "unread") {
    return (
      <p
        className="mt-1 text-2xs text-black/60 dark:text-white/60"
        data-testid="moderation-report-unread"
      >
        Couldn’t load the reported words. Refresh to try again.
      </p>
    );
  }
  return null;
}

function Row({
  row,
  onPerform,
}: {
  row: ModerationRow;
  onPerform: (
    row: ModerationRow,
    action: ResolutionAction,
    options?: { expiresAt?: number; reason?: string },
  ) => Promise<string | null>;
}) {
  const reporter = row.report.reporterPubkey;
  const { report, actions, person, status, subject } = row;
  const nameOf = useUserNames(
    [reporter, person].filter((key): key is string => key !== null),
  );
  const [pickingTimeout, setPickingTimeout] = useState(false);
  const [confirmingBan, setConfirmingBan] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const onHome = isHomePostReport(report);
  const personName = person ? nameOf(person) : "this member";

  return (
    <li
      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
      data-testid="moderation-report-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium text-black dark:text-white">
          {reportTypeLabel(report.reportType)} · about {subject.about}
        </p>
        {/* A status, not a button: a filled pill, unlike the outlined filters and actions. */}
        <span
          className="shrink-0 rounded-full bg-black/[0.06] px-2 py-0.5 text-2xs font-medium text-black/70 dark:bg-white/10 dark:text-white/70"
          data-testid="moderation-report-status"
        >
          {reportStatusLabel(status)}
        </span>
      </div>
      <Subject nameOf={nameOf} row={row} />
      <p className="mt-1 text-2xs text-black/60 dark:text-white/60">
        {reporter ? `Reported by ${nameOf(reporter)}` : "Reported"}
        {report.createdAt ? ` · ${reportDate(report.createdAt)}` : ""}
      </p>
      {report.note ? (
        <p className="mt-1 text-2xs text-black/70 dark:text-white/70">
          Why: “{report.note}”
        </p>
      ) : null}
      {status === "escalated" ? (
        <p
          className="mt-1 text-2xs text-black/60 dark:text-white/60"
          data-testid="moderation-report-escalated"
        >
          Passed on to the people who run this server.
        </p>
      ) : null}
      {actions.length > 0 ? (
        <div className="mt-1.5">
          {pickingTimeout ? (
            <fieldset
              className="flex flex-wrap items-center gap-1.5"
              data-testid="timeout-choices"
            >
              <legend className="float-left mr-1.5 text-2xs text-black/60 dark:text-white/60">
                Mute {personName} everywhere in this community for
              </legend>
              {TIMEOUT_CHOICES.map((choice) => (
                <button
                  className="rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 dark:border-white/10 dark:text-white/70"
                  key={choice.seconds}
                  onClick={() => {
                    setPickingTimeout(false);
                    void onPerform(row, "timeout", {
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
              <p className="w-full text-2xs text-black/60 dark:text-white/60">
                They can still read, but not post in any room or board here. A
                board mute covers one board.
              </p>
            </fieldset>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {actions.map((action) => (
                <button
                  aria-label={`${actionLabel(action, row).replace("…", "")}: ${reportTypeLabel(report.reportType)} report`}
                  className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
                  data-testid={`moderation-${action}`}
                  key={action}
                  onClick={() => {
                    if (action === "timeout") {
                      setPickingTimeout(true);
                    } else if (action === "ban") {
                      setConfirmingBan(true);
                    } else if (action === "delete") {
                      setDeleting(true);
                    } else {
                      void onPerform(row, action);
                    }
                  }}
                  type="button"
                >
                  {action === "delete" ? <Trash2 className="h-3 w-3" /> : null}
                  {action === "timeout" ? <Clock className="h-3 w-3" /> : null}
                  {action === "ban" ? <Ban className="h-3 w-3" /> : null}
                  {actionLabel(action, row)}
                </button>
              ))}
            </div>
          )}
          <ConfirmDialog
            cancelLabel="Cancel"
            confirmLabel={`Ban ${personName}`}
            description={`${personName} can no longer post in this community. You can lift the ban later.`}
            onCancel={() => setConfirmingBan(false)}
            onConfirm={() => {
              setConfirmingBan(false);
              void onPerform(row, "ban");
            }}
            open={confirmingBan}
            title={`Ban ${personName}?`}
          />
          {deleting ? (
            <ReasonDialog
              confirmLabel="Remove"
              description={
                onHome
                  ? "This post will be removed from Home for everyone and the report closed. Its author is told, with your reason."
                  : `This ${removedNoun(subject)} will be removed for everyone and the report closed.`
              }
              destructive
              onClose={() => setDeleting(false)}
              onConfirm={async (reason) => {
                const failed = await onPerform(row, "delete", { reason });
                if (failed !== null) throw new Error(failed);
              }}
              testId="moderation-delete-dialog"
              title={
                onHome
                  ? "Remove this post from Home?"
                  : `Remove this ${removedNoun(subject)}?`
              }
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ModerationQueuePanel() {
  const { access, loading: accessLoading } = useModerationAccess();
  const {
    rows: visible,
    loading,
    error,
    pollPaused,
    acting,
    errors,
    perform,
    refresh,
    filter,
    setFilter,
    hasOlder,
    loadingOlder,
    showOlder,
  } = useModerationQueue(window.location.pathname);
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
        {moderator ? (
          <fieldset className="mb-2 flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">Show reports</legend>
            {QUEUE_FILTERS.map((choice) => (
              <button
                aria-pressed={filter === choice.value}
                className="rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 aria-pressed:border-black/40 aria-pressed:bg-black/5 aria-pressed:text-black dark:border-white/10 dark:text-white/70 dark:aria-pressed:border-white/40 dark:aria-pressed:bg-white/10 dark:aria-pressed:text-white"
                data-testid={`moderation-filter-${choice.value}`}
                key={choice.value}
                onClick={() => setFilter(choice.value)}
                type="button"
              >
                {choice.label}
              </button>
            ))}
          </fieldset>
        ) : null}
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
            {filter === "escalated"
              ? "No escalated reports."
              : filter === "open"
                ? "No reports need review."
                : "No reports right now."}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((row) => (
              <Row key={row.report.id} onPerform={perform} row={row} />
            ))}
          </ul>
        )}
        {moderator && hasOlder ? (
          <button
            className="mt-2 rounded-md border border-black/10 px-2 py-1 text-2xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:text-white/70"
            data-testid="moderation-show-older"
            disabled={loadingOlder}
            onClick={showOlder}
            type="button"
          >
            {loadingOlder ? "Loading older reports…" : "Show older"}
          </button>
        ) : null}
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
            {message} The report stays open. Use the buttons above to try again.
          </p>
        ))}
      </div>
    </div>
  );
}
