/**
 * Whether a plan may be pressed, and if not the one sentence that says why (plan section 5.2, "Blocks"). Pure: every
 * input is something the sheet has already read. The first thing in the list that is wrong is the one said.
 */
import { freshnessOf, type ProjectNumbers } from "../../../money/numbers";
import { runnerRole } from "../../../money/runner";
import type { ProjectTask } from "../../task-record";
import type { Door } from "../door";
import { openCountAt, tieOf } from "../state";
import type { ChainTasks } from "../types";
import { alreadyPlanned, cannotPlan, PLAN_BLOCK } from "./plan-words";
import { hypotheticalRow, plannedAlready, type PlanRead } from "./plan-read";

export interface PlanGateInput {
  numbers: ProjectNumbers;
  queue: ChainTasks;
  task: ProjectTask;
  /** What the chain says now. */
  read: PlanRead;
  /** The share the plan would ask for (null when the pay is too much of the project's money for one task). */
  share: number | null;
  door: Door;
  /** The signed-in wallet. */
  address: string;
  /** The clock a record's age is told by. */
  now: number;
  /** The worker's name, for the sentence about a wallet they did not name. */
  workerName: string;
}

/** What stops the press: a short name for it and the one sentence that says so. */
export interface PlanBlock {
  /** `planned`: this task is already on the network (a send of ours that was waiting may be what put it there). */
  why: "planned" | "other";
  sentence: string;
}

const stop = (sentence: string): PlanBlock => ({ why: "other", sentence });

/** What stops the press, or null when it may be pressed. The first thing in the list that is wrong is the one said. */
export function planBlock(input: PlanGateInput): PlanBlock | null {
  const { numbers, queue, task, read } = input;
  if (numbers.windDown) return stop(PLAN_BLOCK.wound);
  if (freshnessOf(numbers, input.now).level !== "fresh")
    return stop(PLAN_BLOCK.stale);
  if (runnerRole(numbers, input.address).kind === "none")
    return stop(PLAN_BLOCK.notRunner);
  if (input.door.door === "box-only") return stop(input.door.sentence);
  const same = plannedAlready(read, task.id);
  if (same) return { why: "planned", sentence: alreadyPlanned(same.noticeEnd) };
  if (read.activeEnd <= read.time) return stop(PLAN_BLOCK.quiet);
  if (openCountAt(read.open, read.time) >= queue.limits.maxOpen)
    return stop(PLAN_BLOCK.full);
  const tie = tieOf(
    hypotheticalRow(task, BigInt(task.usd ?? 0) * 1_000_000n, input.share ?? 1),
    task,
  );
  if (!tie.ok) return stop(cannotPlan(tie.why, input.workerName));
  if (input.share === null) return stop(PLAN_BLOCK.tooBig);
  return null;
}
