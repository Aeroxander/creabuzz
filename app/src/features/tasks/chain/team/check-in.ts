/**
 * Whether a planned task can be taken, as far as the team's check-in goes (plan section 5.11, C24). A task can only be taken
 * while the team's last check-in still counts; a team that does not check in again makes the plan lapse. Nothing moves then,
 * but a worker or a holder must never be told "can be taken" when it cannot. Pure, from the record's `clock.activeUntil`.
 */
import { phaseOf } from "../state";
import type { ChainTask } from "../types";

/** A plan the worker can still take now or later: announced, and its take window is not over. */
function isPlanned(row: ChainTask, now: number): boolean {
  const phase = phaseOf(row, now);
  return phase === "notice" || phase === "open";
}

/**
 * True when nobody could take this plan at the first moment it can be taken: the check-in stops counting at or before the
 * time the take window opens (or, once it is open, at or before now).
 */
export function cannotBeTaken(
  row: ChainTask,
  activeUntil: number | null,
  now: number,
): boolean {
  return (
    activeUntil !== null &&
    isPlanned(row, now) &&
    activeUntil <= Math.max(row.noticeEnd, now)
  );
}
