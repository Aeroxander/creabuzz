/**
 * A project with a task queue and a team task that has a worker with a wallet, for the team side's screens: the parsed
 * example (moved to now, with its task queue), a task record in the shape the Tasks tab reads, and what the chain answers.
 * Nothing here is retyped from the example: a test reads a number from `numbers`, and changes a row through `withTasks`.
 */
import { act } from "@testing-library/react";
import type { AbiValue } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import type {
  ChainTask,
  ChainTasks,
} from "../../src/features/tasks/chain/types";
import type { ProjectTask } from "../../src/features/tasks/task-record";
import { taskBookAnswers } from "./chain-task-answers";
import { taskRow, withTasks } from "./numbers-v2-fixture";
import { backerAnswers, NOW, numbersFor } from "./pot-harness";

/** The team's task record the scenes are about: its id is what a plan of it names. */
export const TASK_ID = "7".repeat(64);
/** The person who took it, and the wallet they named. */
export const WORKER = "a".repeat(64);
export const WORKER_WALLET = "0x00000000000000000000000000000000000000cd";
/** The founder's key as a person (not the wallet). */
export const FOUNDER_KEY = "f".repeat(64);

/** A task the worker has taken, paying `usd` whole dollars to their wallet. */
export function planTask(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: TASK_ID,
    author: FOUNDER_KEY,
    at: NOW - 3_600,
    what: "Translate the guide",
    usd: 100,
    openToAnyone: true,
    worker: WORKER,
    payTo: WORKER_WALLET,
    state: "working",
    handIn: null,
    acceptedBy: null,
    acceptedAt: null,
    paidTx: null,
    ...over,
  };
}

/** The example with its queue; `patch` changes the content (the queue is `content.tasks`). */
export function sceneNumbers(
  patch?: (content: Record<string, unknown>) => void,
): ProjectNumbers {
  return numbersFor((content) => {
    withTasks()(content);
    patch?.(content);
  });
}

/** The queue of a scene's numbers. */
export function queueOf(numbers: ProjectNumbers): ChainTasks {
  if (typeof numbers.tasks !== "object" || numbers.tasks === null)
    throw new Error("the scene has no queue");
  return numbers.tasks;
}

/** The plan of the scene's task, as the chain would hold it after it was planned: the record's row 7, made to name `TASK_ID`. */
export function planRow(
  numbers: ProjectNumbers,
  patch: Partial<ChainTask> = {},
): ChainTask {
  const open = queueOf(numbers).list.find((r) => r.state === "announced");
  if (!open) throw new Error("the example has no announced row");
  return { ...open, what: `0x${TASK_ID}`, repeatOf: null, ...patch };
}

/**
 * What the chain answers for the team's sheets: the book's and the Treasury's task views (from the record's queue, or from
 * `rows` where the chain says something else), the check-in, and the allowance box as the record has it.
 */
export function sceneAnswers(
  numbers: ProjectNumbers,
  options: {
    rows?: readonly ChainTask[];
    activeEnd?: number;
    nextSerial?: bigint;
  } = {},
): Record<
  string,
  AbiValue[] | ((args: readonly unknown[], to: string) => AbiValue[])
> {
  const queue = queueOf(numbers);
  return {
    ...backerAnswers(numbers),
    ...taskBookAnswers(queue, options.rows ? { rows: options.rows } : {}),
    ...(options.nextSerial === undefined
      ? {}
      : { nextSerial: [options.nextSerial] }),
    activeEnd: [BigInt(options.activeEnd ?? numbers.clock.activeUntil ?? 0)],
    box: [numbers.allowance.box],
    boxCap: [numbers.allowance.boxCap],
  };
}

/** In a record's content (inside a `sceneNumbers` patch): make the row with this serial name the team's task record `taskId`. */
export function pointRow(
  content: Record<string, unknown>,
  serial: number,
  taskId: string = TASK_ID,
): Record<string, unknown> {
  const row = taskRow(content.tasks as Record<string, unknown>, serial);
  row.what = `0x${taskId}`;
  return row;
}

/** The serial of the example's taken row: the one the scenes of a task in progress are made from. */
export const TAKEN_SERIAL = 6;

/**
 * The scene of a task in progress: the example's taken row made to name the team's task record and the worker's wallet (it
 * was taken by that wallet, and paid to nobody else). `patch` changes the content after that.
 */
export function takenNumbers(
  patch?: (content: Record<string, unknown>) => void,
): ProjectNumbers {
  return sceneNumbers((content) => {
    const row = pointRow(content, TAKEN_SERIAL);
    row.payee = WORKER_WALLET;
    row.takenBy = WORKER_WALLET;
    patch?.(content);
  });
}

/** The taken row of a scene made by `takenNumbers`. */
export function takenRowOf(numbers: ProjectNumbers): ChainTask {
  const row = queueOf(numbers).list.find(
    (r) => r.serial === BigInt(TAKEN_SERIAL),
  );
  if (!row) throw new Error("the scene has no taken row");
  return row;
}

/** The team's task record for the taken row: it pays what the row's most is, and work has been handed in. */
export function handedInTask(
  numbers: ProjectNumbers,
  over: Partial<ProjectTask> = {},
): ProjectTask {
  return planTask({
    usd: Number(takenRowOf(numbers).maxDollars / 1_000_000n),
    state: "submitted",
    handIn: {
      id: "ab".repeat(32),
      at: NOW - 600,
      note: "The guide in Spanish",
    },
    ...over,
  });
}

/** The serial of the example's announced row that is not a repeat: the one the scenes of a plan nobody has taken are made from. */
export const PLANNED_SERIAL = 7;

/**
 * The scene of a plan nobody has taken: the example's announced row made to name the team's task record, paid to the
 * worker's wallet. `patch` changes the content after that.
 */
export function plannedNumbers(
  patch?: (content: Record<string, unknown>) => void,
): ProjectNumbers {
  return sceneNumbers((content) => {
    const row = pointRow(content, PLANNED_SERIAL);
    row.payee = WORKER_WALLET;
    patch?.(content);
  });
}

/** The announced row of a scene made by `plannedNumbers`. */
export function plannedRowOf(numbers: ProjectNumbers): ChainTask {
  const row = queueOf(numbers).list.find(
    (r) => r.serial === BigInt(PLANNED_SERIAL),
  );
  if (!row) throw new Error("the scene has no planned row");
  return row;
}

/**
 * Lets the wallet gate answer (it reads the connected account asynchronously, so a press inside it is not there on the first
 * render): what is not on the screen after this really is not offered, and a test that expects an absence says so honestly.
 */
export async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}
