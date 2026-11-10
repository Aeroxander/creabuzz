/**
 * A project's record: what it promised in its updates and what came of each promise, and the goals it reached, missed
 * or changed. Newest first, with plain totals.
 *
 * Misses stay. There is no score here and nothing is compared with another project. When the project's records could
 * not all be read, what was read is shown and the totals are left unsaid, with a way to read again; when they could not
 * be read at all, the card says so. It never shows an empty record for a read that did not finish.
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
  PROMISE_STATE_LABEL,
  type PromiseState,
  promiseTotals,
  promiseTotalsLine,
} from "../lib/promises";
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
          ...(entry.note ? [entry.note] : []),
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
    ].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
    return {
      lines,
      promises: promiseTotalsLine(promiseTotals(record.promises)),
      goals: goalTotalsLine(goalTotals(goals)),
    };
  }, [record]);

  if (!record || !view) {
    if (!failed) return null;
    return (
      <section
        aria-label="Record"
        className="glass rounded-2xl border p-4"
        data-testid="project-record"
      >
        <p className="text-sm" data-testid="record-read-failed" role="alert">
          Couldn't read this project's record.{" "}
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
        Record
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
          can't be worked out. The newest part of its record is below.{" "}
          <Button onClick={retry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      )}
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
              ? "Nothing on the record yet. Each line you write under What's next in an update becomes a promise, and your next update says what came of it."
              : "Nothing on the record yet. It fills in as the project posts updates."}
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
          Show more of the record
        </Button>
      ) : null}
    </section>
  );
}
