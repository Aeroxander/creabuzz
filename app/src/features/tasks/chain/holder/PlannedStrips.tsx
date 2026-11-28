/**
 * The strips above a project's tabs (plan section 5.3): one for each task that is planned or running, at most three, so that
 * every holder reads that money will move, who gets how much at most, and from when, before anything else on the page. A
 * holder can take their money out before then from the strip. All from the signed record, with its age when it is old; the
 * team's own words are used only for a plan that ties to its record. Every figure is the network's.
 */
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { lazy, Suspense, useId } from "react";
import { type ProfileMetadata, useProfiles } from "../../../../lib/profiles";
import { Button } from "../../../../ui/button";
import { holdingHint, type ProjectNumbers } from "../../../money/numbers";
import { PLAY_MONEY_WORDS } from "../../../pot/pot-words";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import { nowOf, phaseOf } from "../state";
import type { ChainTask } from "../types";
import { useTaskJoin } from "../join";
import { NotTakeableLine } from "../team/CheckInLine";
import {
  andMore,
  PLANNED_HEADING,
  RUNNING_HEADING,
  takeOutBefore,
  TAKE_OUT_NOW,
} from "./holder-words";
import { PlannedLines } from "./PlannedLines";

// The Take out sheet carries the money calls and their contract ABIs: it loads when a holder's button is drawn.
const PlannedTakeOut = lazy(() => import("./PlannedTakeOut"));

/** The most strips the page shows; the rest are one press away on the Money tab. */
const MOST_STRIPS = 3;

/** The tasks the strips are about: announced and still to be taken, or taken and not yet over, in the record's order. */
export function stripRows(
  queue: { list: readonly ChainTask[] },
  now: number,
  windDownAt: number | null,
): ChainTask[] {
  return queue.list.filter((row) => {
    const phase = phaseOf(row, now, windDownAt);
    return phase === "notice" || phase === "open" || phase === "working";
  });
}

/** The date a strip's button is named for: when the notice ends; once the plan can be taken there is no "before", so no date. */
function stripDate(row: ChainTask, now: number): number {
  return now < row.noticeEnd ? row.noticeEnd : 0;
}

function takeOutLabel(row: ChainTask, now: number): string {
  return now < row.noticeEnd ? takeOutBefore(row.noticeEnd) : TAKE_OUT_NOW;
}

export function PlannedStrips({
  project,
  numbers,
  address,
  onOpenMoney,
}: {
  project: Project;
  numbers: ProjectNumbers;
  /** The connected wallet's account, when there is one. */
  address: string | null;
  /** Goes to the Money tab (where a person claims what they are owed). */
  onOpenMoney: () => void;
}) {
  const queue =
    typeof numbers.tasks === "object" && numbers.tasks ? numbers.tasks : null;
  const join = useTaskJoin(project, numbers);
  const now = queue ? nowOf(numbers.asOf.time) : 0;
  const rows = queue ? stripRows(queue, now, numbers.windDown?.at ?? null) : [];
  const records = join.status === "ready" ? join.join.tasks : [];
  const workers = records.flatMap((t) =>
    t.task.worker ? [t.task.worker] : [],
  );
  const profiles = useProfiles(workers).data;
  if (!queue || rows.length === 0) return null;
  const taskOf = (row: ChainTask) =>
    join.status === "ready"
      ? (join.join.rows.find((r) => r.row.serial === row.serial)?.task ?? null)
      : null;
  const shown = rows.slice(0, MOST_STRIPS);
  const dates = new Set<number>();
  return (
    <div className="flex flex-col gap-3" data-testid="planned-strips">
      {shown.map((row) => {
        // A button is named for its date, so two strips for the same date draw it once.
        const planned = row.state === "announced";
        const first = planned && !dates.has(stripDate(row, now));
        if (planned) dates.add(stripDate(row, now));
        return (
          <Strip
            address={address}
            drawTakeOut={first}
            key={row.serial.toString()}
            now={now}
            numbers={numbers}
            onOpenMoney={onOpenMoney}
            profiles={profiles}
            project={project}
            row={row}
            task={taskOf(row)}
          />
        );
      })}
      {rows.length > MOST_STRIPS ? (
        <Button onClick={onOpenMoney} variant="secondary">
          {andMore(rows.length - MOST_STRIPS)}
        </Button>
      ) : null}
    </div>
  );
}

function Strip({
  row,
  task,
  numbers,
  now,
  profiles,
  project,
  address,
  drawTakeOut,
  onOpenMoney,
}: {
  row: ChainTask;
  task: ProjectTask | null;
  numbers: ProjectNumbers;
  now: number;
  profiles: Record<string, ProfileMetadata> | undefined;
  project: Project;
  address: string | null;
  drawTakeOut: boolean;
  onOpenMoney: () => void;
}) {
  const titleId = useId();
  const planned = row.state === "announced";
  // The button is only drawn for a plan (`drawTakeOut` is false for a task in progress) and for a holder the record lists.
  const holder = address !== null && holdingHint(numbers, [address]).listed;
  return (
    <section
      aria-labelledby={titleId}
      className="glass glass-text flex flex-col gap-2 rounded-2xl p-4"
      data-state={planned ? "planned" : "running"}
      data-testid="planned-strip"
    >
      <h2 className="headline text-xl" id={titleId}>
        {planned ? PLANNED_HEADING : RUNNING_HEADING}
      </h2>
      <PlannedLines
        now={now}
        numbers={numbers}
        profiles={profiles}
        row={row}
        task={task}
      />
      <NotTakeableLine now={now} numbers={numbers} row={row} />
      {holder && drawTakeOut ? (
        <Suspense fallback={null}>
          <PlannedTakeOut
            label={takeOutLabel(row, now)}
            numbers={numbers}
            onOpenMoney={onOpenMoney}
            projectName={project.name}
          />
        </Suspense>
      ) : null}
      {mustSayPlayMoney(numbers.playMoney) ? (
        <p className="text-sm text-muted" data-testid="strip-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
    </section>
  );
}
