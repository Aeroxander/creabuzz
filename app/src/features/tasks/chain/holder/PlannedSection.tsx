/**
 * The Money tab's "Planned and running tasks" (plan sections 5.3 and 5.11): the same lines as the strips for every task
 * that is planned or running, and under them the money set aside for tasks and the room left under the limit, all from the
 * signed record with its age when it is old. A record whose queue could not be read says so, and that the person's money is
 * not affected. Nothing here is read from the network and nothing stands in front of Take out.
 */
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { useId } from "react";
import { type ProfileMetadata, useProfiles } from "../../../../lib/profiles";
import type { ProjectNumbers } from "../../../money/numbers";
import { PLAY_MONEY_WORDS } from "../../../pot/pot-words";
import type { Project } from "../../../project/project-record";
import { useTaskJoin } from "../join";
import { nowOf } from "../state";
import { NotTakeableLine } from "../team/CheckInLine";
import { ageNoteOf, TASKS_UNREADABLE } from "../words";
import { NO_TASKS_NOW, PLANNED_SECTION, setAsideAndRoom } from "./holder-words";
import { PlannedLines } from "./PlannedLines";
import { stripRows } from "./PlannedStrips";

export function PlannedSection({
  project,
  numbers,
  now,
  profiles: given,
}: {
  project: Project | null;
  numbers: ProjectNumbers;
  /** The page's clock; the record's own time lifts it where the record is newer. */
  now: number;
  profiles?: Record<string, ProfileMetadata> | undefined;
}) {
  const titleId = useId();
  const join = useTaskJoin(project, numbers);
  const records = join.status === "ready" ? join.join.tasks : [];
  const workers = records.flatMap((t) =>
    t.task.worker ? [t.task.worker] : [],
  );
  const found = useProfiles(workers).data;
  const profiles = { ...found, ...given };
  const queue =
    typeof numbers.tasks === "object" && numbers.tasks ? numbers.tasks : null;
  if (numbers.tasks === "unreadable")
    return (
      <p className="text-sm text-muted" data-testid="tasks-unreadable">
        {TASKS_UNREADABLE}
      </p>
    );
  if (!queue) return null;
  const clock = nowOf(numbers.asOf.time, now);
  const rows = stripRows(queue, clock, numbers.windDown?.at ?? null);
  const age = ageNoteOf(numbers, clock);
  return (
    <section
      aria-labelledby={titleId}
      className="glass glass-text flex flex-col gap-3 rounded-2xl p-4"
      data-testid="planned-section"
    >
      <h2 className="headline text-xl" id={titleId}>
        {PLANNED_SECTION}
      </h2>
      {age ? (
        <p className="text-xs text-muted" data-testid="planned-section-age">
          {age}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm" data-testid="planned-none">
          {NO_TASKS_NOW}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              className="flex flex-col gap-1"
              data-testid="planned-row"
              key={row.serial.toString()}
            >
              <PlannedLines
                now={clock}
                numbers={numbers}
                profiles={profiles}
                row={row}
                task={
                  join.status === "ready"
                    ? (join.join.rows.find((r) => r.row.serial === row.serial)
                        ?.task ?? null)
                    : null
                }
                withAge={false}
              />
              <NotTakeableLine now={clock} numbers={numbers} row={row} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted" data-testid="tasks-room">
        {setAsideAndRoom({
          locked: numbers.money.locked,
          roomBps: queue.cap.roomBps,
          backAt: queue.cap.frees.find((f) => f.at > clock)?.at ?? null,
        })}
      </p>
      {mustSayPlayMoney(numbers.playMoney) ? (
        <p className="text-sm text-muted" data-testid="planned-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
    </section>
  );
}
