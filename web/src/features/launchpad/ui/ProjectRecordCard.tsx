/**
 * A project's promises and goals: what it promised in its updates and what came of each promise, and the goals it
 * reached, missed or changed. Newest first, with plain totals. (Not the "Track record" tab, which is about work.)
 *
 * There is no score here and nothing is compared with another project. When the founder's records could not all be
 * read, what was read is shown and the totals are left unsaid, with a way to read again; when they could not be read
 * at all, the card says so. It never shows an empty list for a read that did not finish.
 *
 * A founder can delete their own update records, and the server then stops serving them: this page cannot prevent
 * that. So it does not claim nothing was removed. It says how many update records the founder has deleted, and shows
 * answers left behind by a promise that is gone.
 */

import { useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import {
  allGoals,
  GOAL_LEVEL_LABEL,
  goalRecordEntries,
  goalTotals,
  goalTotalsLine,
} from "../lib/goals";
import {
  MARK_LABEL,
  PROMISE_STATE_LABEL,
  type PromiseState,
  promiseTotals,
  promiseTotalsLine,
} from "../lib/promises";
import { removedLine } from "../lib/removed-records";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";

/** How many lines of the record show at first, and how many more each press adds. */
const PAGE = 10;

const TONE: Record<PromiseState | "reached", ChipTone> = {
  kept: "success",
  reached: "success",
  missed: "danger",
  changed: "warning",
  waiting: "neutral",
  unanswered: "warning",
};

const GOAL_STEP_LABEL = {
  reached: "Goal reached",
  missed: "Goal missed",
  changed: "Goal changed",
} as const;

interface Line {
  key: string;
  at: number;
  tone: ChipTone;
  label: string;
  text: string;
  /** A second line: when it was promised, what it was before, why. */
  detail: string;
}

const day = (at: number) => new Date(at * 1000).toLocaleDateString();

export function ProjectRecordCard({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const { record, failed, stale, retry } = useProjectRecord(launch.record);
  const [shown, setShown] = useState(PAGE);

  const view = useMemo(() => {
    if (!record) return null;
    const goals = allGoals(record.goals);
    const lines: Line[] = [
      ...record.promises.map((entry) => ({
        key: entry.id,
        at: entry.answeredAt ?? entry.promisedAt,
        tone: TONE[entry.state],
        label: PROMISE_STATE_LABEL[entry.state],
        text: entry.text,
        detail: [
          entry.answeredAt === null
            ? entry.state === "waiting"
              ? "For the next update"
              : "A later update did not say"
            : `Promised ${day(entry.promisedAt)}`,
          // Answers that disagree are all shown; the worse one is the one counted.
          ...(entry.conflict
            ? [
                `Answered more than once: ${entry.answers
                  .map(
                    (answer) =>
                      `${MARK_LABEL[answer.state]} on ${day(answer.at)}${answer.note ? ` (${answer.note})` : ""}`,
                  )
                  .join(", ")}. The worse answer is counted`,
              ]
            : entry.note
              ? [entry.note]
              : []),
        ].join(". "),
      })),
      ...goalRecordEntries(goals).map((entry) => ({
        key: `${entry.goalId}-${entry.at}-${entry.step}`,
        at: entry.at,
        tone: TONE[entry.step],
        label:
          entry.level === "primary"
            ? GOAL_STEP_LABEL[entry.step]
            : `${GOAL_STEP_LABEL[entry.step]} (${GOAL_LEVEL_LABEL[entry.level].toLowerCase()})`,
        text: entry.text,
        detail: [
          ...(entry.was ? [`It was: ${entry.was.text}`] : []),
          ...(entry.reason ? [`Why: ${entry.reason}`] : []),
        ].join(". "),
      })),
      ...record.orphans.map((orphan) => ({
        key: `orphan-${orphan.promiseId}-${orphan.at}`,
        at: orphan.at,
        tone: "warning" as const,
        label: "Promise removed",
        text: `Answered "${MARK_LABEL[orphan.state]}"${orphan.note ? ` (${orphan.note})` : ""}`,
        detail:
          "The update that made this promise was removed, so what was promised can't be shown",
      })),
    ].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
    return {
      lines,
      removed: removedLine(record.removed, day),
      promises: promiseTotalsLine(promiseTotals(record.promises)),
      goals: goalTotalsLine(goalTotals(goals)),
    };
  }, [record]);

  if (!record || !view) {
    // Not read yet: the card holds its place and says so. Not readable: said, with a way to read again.
    if (!failed)
      return (
        <section
          aria-busy="true"
          aria-label="Promises and goals"
          className="glass rounded-2xl border p-4"
          data-testid="project-record"
        >
          <p className="text-sm text-muted-foreground">
            Reading promises and goals…
          </p>
        </section>
      );
    return (
      <section
        aria-label="Promises and goals"
        className="glass rounded-2xl border p-4"
        data-testid="project-record"
      >
        <p className="text-sm" data-testid="record-read-failed" role="alert">
          Couldn't read this project's promises and goals.{" "}
          <Button onClick={retry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="project-record-heading"
      className="glass rounded-2xl border p-4"
      data-testid="project-record"
    >
      <h2 className="text-sm font-bold" id="project-record-heading">
        Promises and goals
      </h2>
      <p className="text-xs text-muted-foreground">
        What this project said it would do, and what came of it.
      </p>
      {record.facts.totals ? (
        view.promises || view.goals ? (
          <p className="mt-2 text-sm font-semibold" data-testid="record-totals">
            {view.promises ? (
              <span data-testid="record-promise-totals">{view.promises}</span>
            ) : null}
            {view.promises && view.goals ? " · " : null}
            {view.goals ? (
              <span data-testid="record-goal-totals">{view.goals}</span>
            ) : null}
          </p>
        ) : null
      ) : (
        <p className="mt-2 text-sm" data-testid="record-totals-unknown">
          This project has more records than could be read here, so its totals
          can't be worked out. The newest of them are below.{" "}
          <Button onClick={retry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      )}
      {view.removed ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="record-removed"
        >
          {view.removed} A removed record is not counted here. This counts all
          of the founder's projects, and reopening a help request counts too.
        </p>
      ) : null}
      {stale ? (
        <p className="mt-2 text-sm" role="status">
          Couldn't check for newer records.{" "}
          <Button onClick={retry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      ) : null}
      {view.lines.length === 0 ? (
        record.facts.totals ? (
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="record-empty"
          >
            {isFounder
              ? "No promises yet. Each line you write under What's next in an update becomes a promise, and your next update says what came of it."
              : "No promises yet. They show here as the project posts updates."}
          </p>
        ) : null
      ) : (
        <ol className="mt-3 flex flex-col gap-2" data-testid="record-lines">
          {view.lines.slice(0, shown).map((line) => (
            <li
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
              data-testid="record-line"
              key={line.key}
            >
              <Chip tone={line.tone}>{line.label}</Chip>
              <span className="min-w-0 break-words text-sm">{line.text}</span>
              <span className="text-xs text-muted-foreground">
                {day(line.at)}
              </span>
              {line.detail ? (
                <span className="w-full break-words text-xs text-muted-foreground">
                  {line.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {view.lines.length > shown ? (
        <Button
          className="mt-2"
          data-testid="record-more"
          onClick={() => setShown((n) => n + PAGE)}
          size="sm"
          type="button"
          variant="outline"
        >
          Show more
        </Button>
      ) : null}
    </section>
  );
}
