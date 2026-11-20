/**
 * The scene of the Take sheet's tests: the worker's plan open to be taken, a wallet in the page that answers as the chain
 * would, and what a test does to the chain's answers. `chain` and `numbers` are live: a test reads them after `scene()` set them.
 * Nothing is retyped from the example: a figure is read from the parsed record, a row the chain says otherwise about is
 * changed through the chain's answers.
 */
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { forgetPending, sendKey } from "../../src/features/money/pending-sends";
import { smallDollarsText } from "../../src/features/pot/pot-words";
import type { Project } from "../../src/features/project/project-record";
import type { TaskSlotProps } from "../../src/features/tasks/chain/slot-props";
import { chainRowOf, nowOf } from "../../src/features/tasks/chain/state";
import type { ChainTask } from "../../src/features/tasks/chain/types";
import type { ProjectTask } from "../../src/features/tasks/task-record";
import { SERVER } from "./money-harness";
import { taskRow } from "./numbers-v2-fixture";
import { installPotChain, type PotChain } from "./pot-chain";
import { nameTheNetwork } from "./pot-harness";
import {
  FOUNDER_KEY,
  PLANNED_SERIAL,
  planTask,
  plannedNumbers,
  queueOf,
  sceneAnswers,
  WORKER,
  WORKER_WALLET,
} from "./plan-scene";

export const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;
export const D = 1_000_000n;

export let chain: PotChain;
export let numbers: ProjectNumbers;

export const dollars = (raw: bigint) =>
  raw === D ? "1 dollar" : `${smallDollarsText(raw)} dollars`;
export const confirm = () =>
  screen.getByTestId("sheet-confirm") as HTMLButtonElement;

export function props(
  task: ProjectTask,
  over: Partial<TaskSlotProps> = {},
): TaskSlotProps {
  const queue = queueOf(numbers);
  return {
    project,
    task,
    chain: chainRowOf(queue, task.id),
    tasks: queue,
    numbers,
    me: WORKER,
    address: WORKER_WALLET,
    team: new Set([FOUNDER_KEY]),
    agents: new Set(),
    operators: new Map(),
    profiles: undefined,
    now: nowOf(numbers.asOf.time),
    ...over,
  };
}

/**
 * The plan for the worker's task, open to be taken: the example's announced row, paid to the worker's wallet, with a most the
 * project's money can cover (so the whole most is what a take would set aside), and its notice over. `patch` changes more.
 */
export function scene(
  options: {
    account?: string;
    patch?: (content: Record<string, unknown>) => void;
    notice?: "over" | "running";
  } = {},
) {
  numbers = plannedNumbers((content) => {
    const row = taskRow(
      content.tasks as Record<string, unknown>,
      PLANNED_SERIAL,
    );
    row.maxDollars = String(50n * D);
    if (options.notice !== "running")
      row.noticeEnd = (content.asOf as { time: number }).time - 60;
    options.patch?.(content);
  });
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: options.account ?? WORKER_WALLET,
    answers: sceneAnswers(numbers) as never,
  });
  return planTask({ usd: 50 });
}

/** The chain says something other than the record about the planned row. */
export function chainSays(over: Partial<ChainTask>) {
  Object.assign(
    chain.answers,
    sceneAnswers(numbers, {
      rows: queueOf(numbers).list.map((r) =>
        r.serial === BigInt(PLANNED_SERIAL) ? { ...r, ...over } : r,
      ),
    }),
  );
}

/** The row as the chain has it once `who` took it. */
export function takenBy(who: string): Partial<ChainTask> {
  const now = Math.floor(Date.now() / 1000);
  return {
    state: "taken",
    takenBy: who,
    takenAt: now,
    deadline: now + queueOf(numbers).limits.dueSecs,
    expiresAt: now + queueOf(numbers).limits.dueSecs,
    setAside: 50n * D,
    stayerClaim: 50n * D,
  };
}

export async function openSheet() {
  fireEvent.click(await screen.findByTestId("take-open"));
  return screen.findByTestId("take-named");
}

/** Called once at the top of a test file: the server settings, and a clean page and pending sends after each test. */
export function takeSceneHooks() {
  beforeEach(() => {
    applyServerSettings({ investing: true, self: SERVER });
  });
  afterEach(() => {
    forgetPending(
      sendKey(
        `take-task:${numbers.chainId}:${numbers.contracts.treasury}:${PLANNED_SERIAL}`,
        WORKER_WALLET,
      ),
    );
    cleanup();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    localStorage.clear();
    applyServerSettings(null);
  });
}
