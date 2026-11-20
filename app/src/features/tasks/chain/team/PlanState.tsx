/**
 * What the network says about a task that is planned, taken or paid (plan section 5.4): the headline first, from the signed
 * record's row and the one clock, then its detail, how old the record is when it is not fresh, and when the plan is not for
 * this task as the team wrote it, why. The team's own step ("Work handed in") stays under it, on the card, in muted words:
 * they never swap. Every money figure on a planned task comes from here, never from what the team's record says it pays.
 */
import { nameOf, type ProfileMetadata } from "../../../../lib/profiles";
import type { ProjectNumbers } from "../../../money/numbers";
import type { ProjectTask } from "../../task-record";
import { phaseOf, stateWords, tieOf } from "../state";
import type { ChainTask } from "../types";
import { ageNoteOf } from "../words";
import { NotTakeableLine } from "./CheckInLine";
import { planNotTied } from "./plan-words";

export function PlanState({
  chain,
  task,
  numbers,
  now,
  profiles,
}: {
  chain: ChainTask;
  task: ProjectTask;
  numbers: ProjectNumbers;
  now: number;
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const windDownAt = numbers.windDown?.at ?? null;
  const phase = phaseOf(chain, now, windDownAt);
  // The pay-to is named by profile only when it is the wallet the worker named; otherwise the network's own address shows.
  const named =
    task.worker !== null &&
    task.payTo !== null &&
    chain.payee?.toLowerCase() === task.payTo.toLowerCase()
      ? nameOf(profiles, task.worker)
      : null;
  const words = stateWords(chain, now, { windDownAt, payeeName: named });
  const age = ageNoteOf(numbers, now);
  const tie = tieOf(chain, task);
  return (
    <div className="flex flex-col gap-1" data-testid="task-chain">
      <p
        className="font-semibold"
        data-state={phase}
        data-testid="task-chain-state"
      >
        {words.headline}
      </p>
      {words.detail ? (
        <p className="num text-sm" data-testid="task-chain-detail">
          {words.detail}
        </p>
      ) : null}
      {age ? (
        <p className="text-xs text-muted" data-testid="task-chain-age">
          {age}
        </p>
      ) : null}
      <NotTakeableLine now={now} numbers={numbers} row={chain} />
      {!tie.ok && chain.state !== "paid" ? (
        <p className="text-xs text-muted" data-testid="task-chain-tie">
          {planNotTied(tie.why)}
        </p>
      ) : null}
    </div>
  );
}
