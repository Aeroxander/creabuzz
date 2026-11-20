// The task card mounts the three slots once, only where the signed record carries a task queue, and hands them the network's
// row for this task record and the one clock. Without a queue the card is the step 1 card.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  shapeRow,
  shapeTaskId,
  shapeTasks,
} from "../../../../tests/helpers/chain-task-shape";
import { wrap } from "../../../../tests/helpers/money-harness";
import type { ProjectNumbers } from "../../money/numbers";
import type { Project } from "../../project/project-record";
import type { ProjectTask } from "../task-record";
import { TaskCard } from "../TaskCard";
import type { TaskSlotProps } from "./slot-props";

const seen: Record<string, TaskSlotProps[]> = {
  holder: [],
  worker: [],
  team: [],
};

vi.mock("./holder/HolderLines", () => ({
  HolderLines: (props: TaskSlotProps) => {
    seen.holder?.push(props);
    return <div data-testid="slot-holder" />;
  },
}));
vi.mock("./holder/WorkerActions", () => ({
  WorkerActions: (props: TaskSlotProps) => {
    seen.worker?.push(props);
    return <div data-testid="slot-worker" />;
  },
}));
vi.mock("./team/TeamActions", () => ({
  TeamActions: (props: TaskSlotProps) => {
    seen.team?.push(props);
    return <div data-testid="slot-team" />;
  },
}));
vi.mock("../../money/use-money", () => ({
  useMoneySend: () => ({ isPending: false, send: () => {} }),
  useConnectWallet: () => ({ isPending: false, mutateAsync: async () => null }),
  useWallet: () => ({}),
}));
vi.mock("../use-tasks", () => ({
  freshTask: async () => null,
  useTaskWrite: () => ({ isPending: false, mutate: () => {} }),
}));
vi.mock("../../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));

const FOUNDER = "f".repeat(64);
const project = {
  coordinate: `37001:${FOUNDER}:orbit`,
  author: FOUNDER,
  team: [],
} as unknown as Project;
const ASOF = 1_800_000_000;

function task(n: number): ProjectTask {
  return {
    id: shapeTaskId(n),
    author: FOUNDER,
    at: ASOF - 100,
    what: "Translate the guide",
    usd: 40,
    openToAnyone: false,
    worker: null,
    payTo: null,
    state: "open",
    handIn: null,
    acceptedBy: null,
    acceptedAt: null,
    paidTx: null,
  };
}

function numbersWith(tasks: ProjectNumbers["tasks"]): ProjectNumbers {
  return {
    chainId: 31337,
    playMoney: true,
    asOf: { block: 10, time: ASOF },
    builtAt: ASOF,
    refreshEverySecs: 600,
    clock: { activeUntil: null },
    windDown: null,
    runner: {
      address: "0x00000000000000000000000000000000000000ee",
      isPair: false,
      signers: null,
    },
    contracts: { treasury: "0x20b6000000000000000000000000000000000906" },
    allowance: { box: 0n, ratePpm: 1000 },
    money: { pot: 1_000n },
    tasks,
  } as unknown as ProjectNumbers;
}

function card(n: ProjectNumbers | null, t: ProjectTask = task(1)) {
  return wrap(
    <TaskCard
      address={null}
      agents={new Set()}
      me={FOUNDER}
      numbers={n}
      operators={new Map()}
      profiles={undefined}
      project={project}
      task={t}
      team={new Set([FOUNDER])}
    />,
  );
}

const SLOTS = ["slot-holder", "slot-worker", "slot-team"];

afterEach(() => {
  cleanup();
  for (const list of Object.values(seen)) list.length = 0;
});

describe("the task card's slots", () => {
  it("are mounted once each where the record carries a task queue", () => {
    card(numbersWith(shapeTasks([shapeRow(1n)])));
    for (const id of SLOTS) expect(screen.getAllByTestId(id)).toHaveLength(1);
  });

  it("are not mounted without a queue: older server, no book, unreadable section, or no money numbers at all", () => {
    for (const n of [
      numbersWith(undefined),
      numbersWith(null),
      numbersWith("unreadable"),
      null,
    ]) {
      card(n);
      for (const id of SLOTS) expect(screen.queryByTestId(id)).toBeNull();
      cleanup();
    }
    // and the step 1 card is still the card
    card(numbersWith(undefined));
    expect(screen.getByTestId("task-card")).toBeTruthy();
  });

  it("get the network's row for this task record, found by the record's id, and none for a task with no plan", () => {
    const row = shapeRow(1n);
    card(numbersWith(shapeTasks([row, shapeRow(2n)])), task(1));
    expect(seen.holder?.at(-1)?.chain?.serial).toBe(1n);
    cleanup();
    card(numbersWith(shapeTasks([row])), task(9));
    expect(seen.holder?.at(-1)?.chain).toBeNull();
  });

  it("all get the same props, the record's tasks section and the one clock: never earlier than the record's time", () => {
    const tasks = shapeTasks([shapeRow(1n)]);
    card(numbersWith(tasks));
    const [holder, worker, team] = [seen.holder, seen.worker, seen.team].map(
      (l) => l?.at(-1),
    );
    expect(holder?.tasks).toBe(tasks);
    expect(holder?.me).toBe(FOUNDER);
    expect(holder?.now).toBeGreaterThanOrEqual(ASOF);
    expect(worker?.now).toBe(holder?.now);
    expect(team?.chain).toBe(holder?.chain);
  });
});
