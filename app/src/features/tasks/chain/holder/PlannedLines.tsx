/**
 * What everyone reads about a planned task, signed in or not (plan section 5.3, T5): who would get how much at most, from
 * when, and that they can take their money out before then; then how much would be set aside today. A task that was taken
 * reads as one line of who took it and what is set aside until when. All from the signed record's row and the one clock;
 * the team's own words are used only where the plan ties to its record.
 */
import type { ProjectNumbers } from "../../../money/numbers";
import { NOT_A_RETURN } from "../../../pot/pot-words";
import type { ProjectTask } from "../../task-record";
import { phaseOf } from "../state";
import type { ChainTask } from "../types";
import { ageNoteOf, atMostNowLine, endedLine, plannedLines } from "../words";
import type { ProfileMetadata } from "../../../../lib/profiles";
import { payeeName, takerName, tiedWords } from "./plan-names";

export function PlannedLines({
  row,
  task,
  numbers,
  now,
  profiles,
  withAge = true,
}: {
  row: ChainTask;
  /** The team's record of this task, when there is one. */
  task: ProjectTask | null;
  numbers: ProjectNumbers;
  now: number;
  profiles: Record<string, ProfileMetadata> | undefined;
  /** Whether the record's age is said here (a list says it once, above the rows). */
  withAge?: boolean;
}) {
  const phase = phaseOf(row, now, numbers.windDown?.at ?? null);
  const age = withAge ? ageNoteOf(numbers, now) : null;
  const what = tiedWords(row, task);
  if (phase === "working")
    return (
      <div className="flex flex-col gap-1" data-testid="planned-lines">
        <p className="break-words font-semibold" data-testid="planned-line-1">
          {endedLine({
            task: row,
            phase,
            name: takerName(row, task, profiles),
            what,
          })}
        </p>
        {age ? (
          <p className="text-xs text-muted" data-testid="planned-age">
            {age}
          </p>
        ) : null}
      </div>
    );
  if (phase !== "notice" && phase !== "open") return null;
  const [first, second] = plannedLines({
    max: row.maxDollars,
    name: payeeName(row, task, profiles),
    what,
    date: phase === "notice" ? row.noticeEnd : row.expiresAt,
    open: phase === "open",
  });
  return (
    <div className="flex flex-col gap-1" data-testid="planned-lines">
      <p className="break-words font-semibold" data-testid="planned-line-1">
        {first}
      </p>
      <p className="break-words text-sm" data-testid="planned-line-2">
        {second}
      </p>
      {row.atMostNow !== null ? (
        <p className="break-words text-sm text-muted" data-testid="planned-now">
          {atMostNowLine(row.atMostNow)} {NOT_A_RETURN}
        </p>
      ) : null}
      {age ? (
        <p className="text-xs text-muted" data-testid="planned-age">
          {age}
        </p>
      ) : null}
    </div>
  );
}
