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

import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";

import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";
import { EmptyState } from "@/shared/ui/empty-state";
import { MoreInfo } from "@/shared/ui/more-info";

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
import { memberRemovedLine, removedLine } from "../lib/removed-records";
import { acceptedByOthers, doneAlone, doneAloneLine } from "../lib/task-checks";
import {
  acceptedTasks,
  HOW_WORK_COUNTS,
  orderTime,
  type TaskFile,
  type TaskView,
  taskStateLabel,
} from "../lib/tasks";
import { projectAcceptedLine } from "../lib/track-record";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";
import { useProjectTasks, useTeamRemovals } from "../use-tasks";
import { recordDay, whenWords } from "../lib/record-date";
import { openSoloWin } from "../lib/solo-win-events";
import { CheckedBy } from "./CheckedBy";
import { JustAcceptedShare } from "./JustAcceptedShare";
import { useSoloAccess } from "./SoloWinHost";
import { EvidenceLinks } from "./TaskParts";

/** A moment in the record's one date style: "today", "3 days ago", "Nov 9". */
const when = (seconds: number) =>
  whenWords(seconds, Math.floor(Date.now() / 1000));

/** How many lines of the record show at first, and how many more each press adds. */
const PAGE = 10;

const TONE: Record<PromiseState | "reached", ChipTone> = {
  kept: "success",
  reached: "success",
  // A miss is a fact, not an alarm: it is said in words and is never red.
  missed: "warning",
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
  /** Finished work: who did it and who checked it, as one line (`CheckedBy`). */
  task?: TaskView;
  /** A promise still waiting for the next update: its words, for "Do it now". */
  doIt?: string;
  /** Accepted work: the links and files that were handed in. */
  links?: readonly string[];
  files?: readonly TaskFile[];
  /** What a test finds the line by, when it is not a promise or a goal. */
  testId?: string;
}

/**
 * A project's finished and closed tasks as lines of its record. A give-up or a cancel stays on the record whatever
 * came after, so one task can have more than one line. A task its helper never said yes to leaves no line: it says
 * nothing about them.
 */
function taskLines(
  tasks: readonly TaskView[],
  names: (pubkey: string) => string,
  now: number,
  complete: boolean,
  asFounder: boolean,
): Line[] {
  const lines: Line[] = acceptedTasks(tasks, now).flatMap((task) =>
    task.accepted
      ? [
          {
            key: `task-${task.id}`,
            at: orderTime(task.accepted.confirmedAt, now),
            tone: task.selfChecked
              ? ("neutral" as const)
              : ("success" as const),
            // A cut read may have missed a send-back of the same piece: it is not called accepted outright.
            // Work only the founder checked for themself is never called accepted at all.
            label: task.selfChecked
              ? taskStateLabel(task, asFounder)
              : complete
                ? "Work accepted"
                : "Work accepted, as far as was read",
            text: task.what,
            task,
            // "Done means" is said when it adds something: the solo box writes the same line twice.
            detail: sameWords(task.done, task.what)
              ? ""
              : `Done means: ${task.done}`,
            links: task.accepted.links,
            files: task.accepted.files,
            testId: task.selfChecked
              ? "record-work-alone"
              : "record-work-accepted",
          },
        ]
      : [],
  );
  for (const task of tasks) {
    if (task.agreed === null) continue;
    if (task.gaveUp)
      lines.push({
        key: `task-${task.id}-gave-up`,
        at: orderTime(task.gaveUp.at, now),
        tone: "warning",
        label: "Task given up",
        text: task.what,
        detail: `${names(task.helper)} gave it up${task.gaveUp.note ? `: ${task.gaveUp.note.replace(/\.$/, "")}` : ""}${task.state === "confirmed" ? ". Work on it was confirmed all the same" : ""}`,
        testId: "record-task-closed",
      });
    if (task.cancelled)
      lines.push({
        key: `task-${task.id}-cancelled`,
        at: orderTime(task.cancelled.at, now),
        tone: "neutral",
        label: "Task cancelled",
        text: task.what,
        detail: `Cancelled by ${names(task.cancelled.by)}: ${task.cancelled.note.replace(/\.$/, "")}${task.state === "confirmed" ? ". Work on it was confirmed all the same" : ""}`,
        testId: "record-task-closed",
      });
  }
  return lines;
}

/** Two lines of words that say the same thing, ignoring case, spacing and a closing full stop. */
function sameWords(a: string, b: string): boolean {
  const flat = (text: string) =>
    text.replace(/\s+/g, " ").trim().replace(/\.$/, "").toLowerCase();
  return flat(a) === flat(b);
}

export function ProjectRecordCard({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const { record, failed, stale, retry } = useProjectRecord(launch.record);
  const [shown, setShown] = useState(PAGE);
  const solo = useSoloAccess();
  // The project's tasks are their own read: when it fails or is cut, the promises and goals still show.
  const work = useProjectTasks(launch.record);
  const closed = useMemo(
    () =>
      (work.tasks ?? []).filter(
        (task) =>
          // A task nobody said yes to is not part of the record.
          task.agreed !== null &&
          (task.state === "confirmed" ||
            task.gaveUp !== null ||
            task.cancelled !== null),
      ),
    [work.tasks],
  );
  const teamRemovals = useTeamRemovals(launch.record);
  const names = useUserNames([
    ...(teamRemovals?.members.map((member) => member.pubkey) ?? []),
    ...closed.flatMap((task) => [
      task.helper,
      ...(task.accepted?.confirmed.map((c) => c.by) ?? []),
      ...(task.cancelled ? [task.cancelled.by] : []),
    ]),
  ]);

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
        doIt: entry.state === "waiting" ? entry.text : undefined,
        detail: [
          entry.answeredAt === null
            ? entry.state === "waiting"
              ? "For the next update"
              : "A later update did not say"
            : `Promised ${when(entry.promisedAt)}`,
          // Answers that disagree are all shown; the worse one is the one counted.
          ...(entry.conflict
            ? [
                `Answered more than once: ${entry.answers
                  .map(
                    (answer) =>
                      `${MARK_LABEL[answer.state]} ${when(answer.at)}${answer.note ? ` (${answer.note})` : ""}`,
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
      ...taskLines(
        closed,
        names,
        Math.floor(Date.now() / 1000),
        work.complete,
        isFounder,
      ),
    ].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
    return {
      lines,
      // Two numbers, never one: what someone else accepted, and what the founder did alone and checked themself.
      work: work.tasks
        ? projectAcceptedLine(acceptedByOthers(closed).length)
        : null,
      // To the founder it is "checked by you".
      alone: work.tasks
        ? (doneAloneLine(doneAlone(closed).length)?.replace(
            "checked by the founder",
            isFounder ? "checked by you" : "checked by the founder",
          ) ?? null)
        : null,
      removed: removedLine(record.removed, recordDay),
      promises: promiseTotalsLine(promiseTotals(record.promises)),
      goals: goalTotalsLine(goalTotals(goals)),
    };
  }, [record, closed, names, work.tasks, work.complete, isFounder]);

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
      // Set once the project's tasks were read (or could not be): what the card says about work is settled.
      data-work-read={work.tasks || work.failed ? "true" : undefined}
    >
      <h2 className="text-sm font-bold" id="project-record-heading">
        Promises and goals
      </h2>
      <MoreInfo label="How work counts" testId="record-how-work-counts">
        <p data-testid="record-how-work-counts-text">{HOW_WORK_COUNTS}</p>
        <p className="mt-1">
          A project's team can change, and work counts as accepted by the team
          as it is now.
        </p>
      </MoreInfo>
      <JustAcceptedShare launch={launch} />
      {work.failed ? (
        <p
          className="mt-2 text-sm"
          data-testid="record-work-failed"
          role="alert"
        >
          Couldn't read this project's finished tasks.{" "}
          <Button
            onClick={work.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : work.tasks && !work.complete ? (
        <p className="mt-2 text-sm" data-testid="record-work-cut" role="status">
          This project has more task records than could be read here, so how
          much work it accepted can't be worked out. What was read is below.
        </p>
      ) : view.work && closed.some((t) => t.state === "confirmed") ? (
        <>
          {acceptedByOthers(closed).length > 0 ? (
            <p
              className="mt-2 text-sm font-semibold"
              data-testid="record-work-totals"
            >
              {view.work}
            </p>
          ) : null}
          {view.alone ? (
            <p
              className="mt-2 text-sm font-semibold"
              data-testid="record-work-alone-totals"
            >
              {view.alone}
            </p>
          ) : null}
        </>
      ) : null}
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
          {view.removed}
          {record.removed.count + record.removed.unnamed > 0
            ? " A removed record is not counted here. This counts all of the founder's projects, and reopening a help request counts too."
            : null}
        </p>
      ) : null}
      {teamRemovals &&
      teamRemovals.members.length + teamRemovals.unchecked > 0 ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="record-team-removed"
        >
          {teamRemovals.members
            .flatMap(
              (member) =>
                memberRemovedLine(
                  names(member.pubkey),
                  member.removed,
                  recordDay,
                ) ?? [],
            )
            .join(" ")}
          {teamRemovals.unchecked > 0
            ? ` Removals by ${teamRemovals.unchecked} more of the team were not checked.`
            : null}{" "}
          Anyone on the team can remove a record they signed (a task, a
          send-back, a confirmation), and it is then not shown or counted here.
          The count covers everything they removed on this server.
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
          <EmptyState
            action={
              isFounder && solo.available ? (
                <Button
                  data-testid="record-add-what-you-did"
                  onClick={() => openSoloWin()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Add what you did
                </Button>
              ) : undefined
            }
            className="mt-2"
            line={
              isFounder
                ? "Finish one thing and it shows here."
                : "It shows here as the project posts updates and finishes work."
            }
            testId="record-empty"
            title={
              isFounder
                ? "Nothing on your record yet."
                : "Nothing on the record yet."
            }
          />
        ) : null
      ) : (
        <ol className="mt-3 flex flex-col gap-2" data-testid="record-lines">
          {view.lines.slice(0, shown).map((line) => (
            <li
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
              data-testid={line.testId ?? "record-line"}
              key={line.key}
            >
              <Chip tone={line.tone}>{line.label}</Chip>
              <span className="min-w-0 break-words text-sm">{line.text}</span>
              <span className="text-xs text-muted-foreground">
                {when(line.at)}
              </span>
              {line.task ? (
                <CheckedBy
                  className="w-full text-sm"
                  task={line.task}
                  viewer={existingUserPubkey()}
                />
              ) : null}
              {line.doIt && solo.available ? (
                <Button
                  aria-label={`Do it now: ${line.doIt}`}
                  className="h-auto p-0"
                  data-testid="record-do-it-now"
                  onClick={() => openSoloWin({ text: line.doIt })}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  Do it now
                </Button>
              ) : null}
              {line.detail ? (
                <span className="w-full break-words text-xs text-muted-foreground">
                  {line.detail}
                </span>
              ) : null}
              {line.links || line.files ? (
                <span className="w-full">
                  <EvidenceLinks
                    files={line.files ?? []}
                    links={line.links ?? []}
                  />
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
