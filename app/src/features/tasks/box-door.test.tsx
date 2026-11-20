// One door: the two box presses (Accept and pay, Pay from the box) ask the chain whether a plan of the task stands, because
// the signed record can be older than the plan (or its tasks section unreadable). Paying a planned task from the box pays it twice.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
} from "../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  planRow,
  planTask,
  queueOf,
  sceneAnswers,
  sceneNumbers,
  TASK_ID,
} from "../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { forgetPaid } from "./paid-journal";
import type { ProjectTask } from "./task-record";
import { TaskCard } from "./TaskCard";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
let fresh: ProjectTask | null = null;
vi.mock("./use-tasks", () => ({
  freshTask: async () => fresh,
  useTaskWrite: () => ({ isPending: false, mutate: () => {} }),
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;

let numbers: ProjectNumbers;

beforeEach(() => {
  forgetPaid(TASK_ID);
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

/** The signed record has no row for the task (it is older than the plan), the chain has the plan announced. */
function staleRecordScene(task: ProjectTask, unreadable = false) {
  numbers = sceneNumbers();
  nameTheNetwork(numbers);
  const queue = queueOf(numbers);
  const plan = planRow(numbers, { serial: queue.nextSerial });
  fresh = task;
  const answers = sceneAnswers(numbers, {
    rows: [...queue.list, plan],
    nextSerial: plan.serial + 1n,
  }) as Record<string, unknown>;
  // The network does not say which book the project keeps: whether a plan stands cannot be known.
  if (unreadable)
    answers.tasks = () => {
      throw new Error("The node did not answer.");
    };
  const chain = installPotChain({
    account: FOUNDER_EVM,
    answers: answers as never,
  });
  wrap(
    <TaskCard
      address={FOUNDER_EVM}
      agents={new Set()}
      me={FOUNDER_KEY}
      numbers={numbers}
      operators={new Map()}
      profiles={undefined}
      project={project}
      task={task}
      team={new Set([FOUNDER_KEY])}
    />,
  );
  return chain;
}

describe("one door, on the network", () => {
  it("Pay from the box does not pay a task that has a plan on the network (record older than the plan)", async () => {
    const task = planTask({
      usd: 1,
      state: "accepted",
      acceptedBy: FOUNDER_KEY,
      acceptedAt: Math.floor(Date.now() / 1000) - 60,
      handIn: { id: "1".repeat(64), at: 1, note: "done" },
    });
    expect(task.id).toBe(TASK_ID);
    const chain = staleRecordScene(task);
    const press = await screen.findByTestId("task-pay");
    fireEvent.click(press);
    await new Promise((r) => setTimeout(r, 400));
    // A draw from the box for a task the network has planned is a second door: nothing may be sent.
    expect(chain.sent).toEqual([]);
  });

  it("Accept and pay does not pay a task that has a plan on the network (record older than the plan)", async () => {
    const task = planTask({
      usd: 1,
      state: "submitted",
      handIn: { id: "1".repeat(64), at: 1, note: "done" },
    });
    const chain = staleRecordScene(task);
    const press = await screen.findByTestId("task-accept");
    fireEvent.click(press);
    await new Promise((r) => setTimeout(r, 600));
    expect(chain.sent).toEqual([]);
  });

  it("sends nothing when the network cannot say whether a plan stands", async () => {
    const task = planTask({
      usd: 1,
      state: "accepted",
      acceptedBy: FOUNDER_KEY,
      acceptedAt: Math.floor(Date.now() / 1000) - 60,
      handIn: { id: "1".repeat(64), at: 1, note: "done" },
    });
    const chain = staleRecordScene(task, true);
    fireEvent.click(await screen.findByTestId("task-pay"));
    await screen.findByTestId("task-pay-problem");
    expect(chain.sent).toEqual([]);
  });
});
