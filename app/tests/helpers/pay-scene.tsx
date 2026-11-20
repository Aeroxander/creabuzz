/**
 * The scene of the team's pay sheet: a project whose task is taken on the network and whose work was handed in, a wallet in the
 * page that answers from the record's queue (or from what the chain says now), and the card that mounts the team's presses.
 * `chain`, `numbers` and `setAside` are set by `setup()` and read by the tests that import them.
 */
import { signatureOf } from "@creaton/core/pot/abi-codec.ts";
import { TASK_BOOK_ABI } from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { fireEvent, screen } from "@testing-library/react";
import { wrap } from "./money-harness";
import { installPotChain, type PotChain } from "./pot-chain";
import { FOUNDER_EVM, nameTheNetwork } from "./pot-harness";
import {
  FOUNDER_KEY,
  handedInTask,
  queueOf,
  sceneAnswers,
  TAKEN_SERIAL,
  takenNumbers,
  takenRowOf,
} from "./plan-scene";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import type { Project } from "../../src/features/project/project-record";
import type { ProjectTask } from "../../src/features/tasks/task-record";
import type { TaskSlotProps } from "../../src/features/tasks/chain/slot-props";
import { chainRowOf, nowOf } from "../../src/features/tasks/chain/state";
import type { ChainTask } from "../../src/features/tasks/chain/types";
import { TeamActions } from "../../src/features/tasks/chain/team/TeamActions";

export const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;
export const PAIR = "0x00000000000000000000000000000000000000ff";
export const SECOND = "0x00000000000000000000000000000000000000dd";
export const PAID_TX = `0x${"c1".repeat(32)}`;
export const RESOLVED = topicOf(
  signatureOf(
    TASK_BOOK_ABI.find(
      (i) => i.type === "event" && i.name === "TaskResolved",
    ) as never,
  ),
);
export const serialTopic = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}`;

export let chain: PotChain;
export let numbers: ProjectNumbers;
export let setAside: bigint;

export function props(
  over: Partial<TaskSlotProps> & { task?: ProjectTask } = {},
): TaskSlotProps {
  const task = over.task ?? handedInTask(numbers);
  const queue = queueOf(numbers);
  return {
    project,
    task,
    chain: chainRowOf(queue, task.id),
    tasks: queue,
    numbers,
    me: FOUNDER_KEY,
    address: FOUNDER_EVM,
    team: new Set([FOUNDER_KEY]),
    agents: new Set(),
    operators: new Map(),
    profiles: undefined,
    now: nowOf(numbers.asOf.time),
    ...over,
  };
}

/** The chain's row for the scene's task, changed by `over`. */
export const rowWith = (over: Partial<ChainTask>): ChainTask => ({
  ...takenRowOf(numbers),
  ...over,
});

export function setup(
  options: {
    patch?: (content: Record<string, unknown>) => void;
    /** What the chain says the task is now, when that differs from the record. */
    chainRow?: Partial<ChainTask>;
  } = {},
) {
  numbers = takenNumbers(options.patch);
  nameTheNetwork(numbers);
  setAside = takenRowOf(numbers).setAside;
  const rows = options.chainRow
    ? queueOf(numbers).list.map((r) =>
        r.serial === BigInt(TAKEN_SERIAL) ? rowWith(options.chainRow ?? {}) : r,
      )
    : undefined;
  chain = installPotChain({
    account: FOUNDER_EVM,
    answers: sceneAnswers(numbers, rows ? { rows } : {}) as never,
    logs: [
      {
        address: queueOf(numbers).book,
        topics: [RESOLVED, serialTopic(TAKEN_SERIAL)],
        data: "0x",
        blockNumber: "0x10",
        transactionHash: PAID_TX,
      },
    ],
  });
}

/** The chain after the payment: the task is paid, and what was paid is `pay`. */
export function chainPays(pay: bigint) {
  Object.assign(
    chain.answers,
    sceneAnswers(numbers, {
      rows: queueOf(numbers).list.map((r) =>
        r.serial === BigInt(TAKEN_SERIAL)
          ? rowWith({ state: "paid", pay, returned: setAside - pay })
          : r,
      ),
    }),
  );
}

export const show = (over: Parameters<typeof props>[0] = {}) =>
  wrap(<TeamActions {...props(over)} />);

export async function openSheet() {
  fireEvent.click(await screen.findByTestId("pay-open"));
  await screen.findByTestId("accept-pay-to");
}

export const confirm = () =>
  screen.getByTestId("sheet-confirm") as HTMLButtonElement;
