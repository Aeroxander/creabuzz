/**
 * What sits under one handed-in piece of work beyond its words: the numbers the helper reported, and the run record
 * they signed for it.
 *
 * Both are the helper's own. The numbers are labelled "Reported by the helper, not run by anyone else"; the line "Meets
 * the stated threshold" is this page's arithmetic on those numbers and the words of "Done means" (`task-results.ts`),
 * and says so. A run record shows what the helper's own run said (verified as theirs, not as true), never a check by
 * anyone else, and a record signed by someone who is not the helper is counted but never shown as their run.
 */

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

import {
  type CheckRunRecord,
  derivedCounts,
  statusLabel,
} from "../lib/check-runs";
import {
  meetsThreshold,
  readResults,
  thresholdLine,
  type ThresholdVerdict,
} from "../lib/task-results";
import type { TaskEvidence } from "../lib/tasks";
import type { TaskRunRecords } from "../use-task-run-records";
import { day } from "./TaskParts";

const VERDICT_WORDS: Record<ThresholdVerdict, string> = {
  yes: "yes",
  no: "no",
  "not stated": "not stated",
};

const REPORTED_LABEL = "Reported by the helper, not run by anyone else";

/** The numbers a piece reports, with the one threshold line. Nothing when the piece reports none. */
function ReportedNumbers({
  piece,
  done,
}: {
  piece: TaskEvidence;
  done: string;
}) {
  if (piece.resultsBroken)
    return (
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="task-results-broken"
      >
        This piece carries numbers that do not follow the rules the server holds
        them to, so none of them is shown.
      </p>
    );
  if (piece.results.length === 0) return null;
  const verdict = meetsThreshold(done, piece.results);
  const { readings } = readResults(done, piece.results);
  return (
    <div className="mt-2" data-testid="task-results">
      <p className="text-xs font-medium text-muted-foreground">
        Results · <span data-testid="task-results-label">{REPORTED_LABEL}</span>
      </p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            Numbers the helper reported with this piece of work
          </caption>
          <thead>
            <tr className="text-muted-foreground">
              <th className="pr-2 font-medium" scope="col">
                Name
              </th>
              <th className="pr-2 font-medium" scope="col">
                Value
              </th>
              <th className="pr-2 font-medium" scope="col">
                Compared with
              </th>
              <th className="pr-2 font-medium" scope="col">
                Sample size
              </th>
              <th className="font-medium" scope="col">
                What produced it
              </th>
            </tr>
          </thead>
          <tbody>
            {piece.results.map((result, i) => (
              <tr
                className="align-top"
                data-testid="task-result-row"
                key={result.name.toLowerCase()}
              >
                <th className="break-words pr-2 font-medium" scope="row">
                  {result.name}
                  {readings[i]?.stated ? (
                    <span className="block font-normal text-muted-foreground">
                      The words say “{readings[i].stated}”:{" "}
                      {VERDICT_WORDS[readings[i].verdict]}
                    </span>
                  ) : null}
                </th>
                <td className="pr-2">
                  {result.value}
                  {result.unit ? ` ${result.unit}` : ""}
                </td>
                <td className="pr-2">
                  {result.baseline
                    ? `${result.baseline}${result.unit ? ` ${result.unit}` : ""}`
                    : "—"}
                </td>
                <td className="pr-2">{result.sampleSize || "—"}</td>
                <td className="break-words">{result.producedBy || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        className="mt-1 text-sm"
        data-testid="task-threshold"
        data-verdict={verdict}
      >
        {thresholdLine(verdict).lead}
        {thresholdLine(verdict).answer === null ? null : (
          <strong>{thresholdLine(verdict).answer}</strong>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        Worked out here from the helper's numbers and the words of “Done means”.
        Nobody ran these numbers, so read the work itself too.
      </p>
    </div>
  );
}

/** One run record, as the signer's own: who signed it, what it ran, and what it does not say. */
function RunRecordBlock({
  record,
  helperName,
}: {
  record: CheckRunRecord;
  helperName: string;
}) {
  const counts = derivedCounts(record.checks);
  return (
    <div className="mt-2" data-testid="task-run-record">
      <p className="text-xs font-medium text-muted-foreground">Run record</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Signed by {helperName} (
        <code title={record.author}>{truncatePubkey(record.author)}</code>) on{" "}
        {day(record.createdAt)}. It shows what their own run said. It is not a
        check by anyone else, and it does not say the work is good.
      </p>
      <p className="mt-1 text-xs" data-testid="task-run-record-tally">
        {counts.passed} passed · {counts.failed} failed · {counts.timedOut}{" "}
        timed out · {counts.notRun} not run
        {counts.contradicted > 0
          ? ` · ${counts.contradicted} contradicting themselves`
          : ""}
        {record.summaryConsistent
          ? ""
          : ". The record's own totals do not agree with its list of checks, so these are counted from the list."}
      </p>
      <ul className="mt-1 list-disc pl-4 text-xs">
        {record.checks.map((check) => (
          <li key={`${check.name}:${check.argv.join(" ")}`}>
            {check.name}:{" "}
            {check.selfContradicted
              ? "the record says passed but the check ended with an error code, so it counts as neither"
              : statusLabel(check.status)}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">
        {record.sandboxClaim === "enforced"
          ? "The helper says the checks ran in a protected space. This page cannot confirm that."
          : "The record does not confirm the checks ran in a protected space, so they may have run without protection, or not at all."}
      </p>
    </div>
  );
}

/**
 * Under one handed-in piece: its reported numbers, the run log and run record it names, and any run record the helper
 * signed for this very piece.
 */
export function HandedInExtras({
  piece,
  done,
  helperName,
  runs,
  readNotes = false,
}: {
  piece: TaskEvidence;
  done: string;
  helperName: string;
  runs: TaskRunRecords;
  /** Say how the run-record read went (failed, cut short). Once per task, not under every piece. */
  readNotes?: boolean;
}) {
  const found = runs.forPiece(piece.id);
  const named = piece.runRecord ? runs.byId(piece.runRecord) : null;
  return (
    <div data-testid="task-evidence-extras">
      <ReportedNumbers done={done} piece={piece} />
      {piece.runLog ? (
        <p
          className="mt-1 break-all text-xs text-muted-foreground"
          data-testid="task-run-log"
        >
          Run log kept by the helper: {piece.runLog.name || "no name"}, with the
          fingerprint <code>{piece.runLog.sha256}</code>. The file is not
          uploaded, so this page cannot check it.
        </p>
      ) : null}
      {piece.runRecord ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="task-run-record-named"
        >
          This hand-in names run record{" "}
          <code title={piece.runRecord}>{truncatePubkey(piece.runRecord)}</code>
          .{" "}
          {runs.status === "ready"
            ? named
              ? "It is shown under the piece it ran against."
              : "This page did not find it for this task, so no run record is shown for it."
            : ""}
        </p>
      ) : null}
      {found.current.length > 0 ? (
        <RunRecordBlock helperName={helperName} record={found.current[0]} />
      ) : null}
      {found.others > 0 ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="task-run-record-others"
        >
          {found.others === 1
            ? "One run record for this piece was"
            : `${found.others} run records for this piece were`}{" "}
          signed by someone who is not the helper. They are not shown as the
          helper's run.
        </p>
      ) : null}
      {readNotes && runs.status === "failed" ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="task-run-record-failed"
          role="status"
        >
          Could not look for run records just now. This does not say whether any
          exist.{" "}
          <Button
            onClick={runs.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : null}
      {readNotes && runs.partial && runs.status === "ready" ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="task-run-record-partial"
        >
          This page read the newest run records only; older ones may exist.
        </p>
      ) : null}
    </div>
  );
}
