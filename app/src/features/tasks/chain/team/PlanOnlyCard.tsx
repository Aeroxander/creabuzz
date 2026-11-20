/**
 * A plan on the network with no task record here that names it (plan section 5.11): its own card, so a team cannot plan
 * something a holder cannot see. It shows the network's numbers and nothing from anyone's record.
 */
import { useId } from "react";
import { timeText } from "../../../money/numbers";
import { phaseOf, stateWords } from "../state";
import type { ChainTask } from "../types";
import { dollarsPhrase } from "../words";
import { secondPlan } from "./plan-words";

/** "A planned task with no matching task here: 40 dollars to 0x…, from 3 Dec, 14:05" (a second plan of a task says so instead). */
function planOnlyWords(row: ChainTask, who: string): string {
  const head =
    row.repeatOf !== null
      ? "A second plan for a task that is already planned"
      : "A planned task with no matching task here";
  return `${head}: ${dollarsPhrase(row.maxDollars)} to ${who}, from ${timeText(row.noticeEnd)}`;
}

export function PlanOnlyCard({
  row,
  now,
  windDownAt,
  ageNote,
}: {
  row: ChainTask;
  now: number;
  windDownAt: number | null;
  /** "as of …" when the record is old. */
  ageNote: string | null;
}) {
  const titleId = useId();
  const who = row.payee ?? "whoever takes it";
  const phase = phaseOf(row, now, windDownAt);
  const words = stateWords(row, now, { windDownAt });
  return (
    <article
      aria-labelledby={titleId}
      className="plain flex flex-col gap-2 rounded-2xl p-4"
      data-testid="plan-only-card"
    >
      <p
        className="font-semibold"
        data-state={phase}
        data-testid="plan-only-state"
      >
        {words.headline}
      </p>
      {words.detail ? (
        <p className="text-sm text-muted">{words.detail}</p>
      ) : null}
      {ageNote ? <p className="text-xs text-muted">{ageNote}</p> : null}
      <h3 className="text-sm" id={titleId}>
        {planOnlyWords(row, who)}
      </h3>
      {row.repeatOf !== null ? (
        <p className="text-xs text-muted" data-testid="plan-only-repeat">
          {secondPlan(row.repeatOf)}
        </p>
      ) : null}
    </article>
  );
}
