/**
 * The two lines about the team's check-in and planned tasks (plan section 5.11, C24): the team's own reminder on the Tasks tab,
 * and the line every reader sees on a card whose plan cannot be taken unless the team checks in.
 */
import { Link } from "@tanstack/react-router";
import type { ProjectNumbers } from "../../../money/numbers";
import type { ChainTask, ChainTasks } from "../types";
import { cannotBeTaken, plansNeedingCheckIn } from "./check-in";
import { notTakeable, teamCheckIn } from "./plan-words";

/** For the team, once at the top of the Tasks tab: planned tasks that nobody can take unless the project checks in again. */
export function CheckInLine({
  numbers,
  queue,
  now,
}: {
  numbers: ProjectNumbers;
  queue: ChainTasks;
  now: number;
}) {
  const until = numbers.clock.activeUntil;
  const need = plansNeedingCheckIn(queue, until, now);
  if (!need || until === null || numbers.windDown) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-2xl bg-white/8 px-4 py-3"
      data-testid="check-in-line"
    >
      <p className="text-sm">
        {teamCheckIn({
          count: need.count,
          from: need.from,
          activeUntil: until,
        })}
      </p>
      <Link
        className="link inline-flex min-h-11 items-center text-sm font-semibold"
        to="/week"
      >
        Go to this week
      </Link>
    </div>
  );
}

/** On a task's card, for everyone: this plan cannot be taken unless the team checks in before the date. */
export function NotTakeableLine({
  row,
  numbers,
  now,
}: {
  row: ChainTask;
  numbers: ProjectNumbers;
  now: number;
}) {
  const until = numbers.clock.activeUntil;
  if (until === null || numbers.windDown || !cannotBeTaken(row, until, now))
    return null;
  return (
    <p className="text-sm" data-testid="task-not-takeable">
      {notTakeable(until)}
    </p>
  );
}
