// Returning the money of a task that ran out: shown to anyone, only on a taken task past its deadline; the sheet reads the
// network's clock and the task, stops with a sentence when it is early or already settled, and sends the one call.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../../../tests/helpers/money-harness";
import { taskRow } from "../../../../../tests/helpers/numbers-v2-fixture";
import {
  installPotChain,
  type PotChain,
} from "../../../../../tests/helpers/pot-chain";
import {
  nameTheNetwork,
  STRANGER_EVM,
} from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  planTask,
  queueOf,
  sceneAnswers,
  settled,
  TAKEN_SERIAL,
  takenNumbers,
  takenRowOf,
} from "../../../../../tests/helpers/plan-scene";
import { timeText, type ProjectNumbers } from "../../../money/numbers";
import { forgetPending, sendKey } from "../../../money/pending-sends";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import type { TaskSlotProps } from "../slot-props";
import { chainRowOf, nowOf } from "../state";
import type { ChainTask } from "../types";
import { ReturnOffer } from "./ReturnOffer";
import { WorkerActions } from "./WorkerActions";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));
vi.mock("../../use-tasks", () => ({
  freshTask: async () => null,
  useTaskWrite: () => ({ isPending: false, mutate: () => {} }),
}));

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;

let chain: PotChain;
let numbers: ProjectNumbers;
const confirm = () => screen.getByTestId("sheet-confirm") as HTMLButtonElement;

function props(
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
    me: null,
    address: STRANGER_EVM,
    team: new Set([FOUNDER_KEY]),
    agents: new Set(),
    operators: new Map(),
    profiles: undefined,
    now: nowOf(numbers.asOf.time),
    ...over,
  };
}

/** The taken task, with its deadline already passed on the record's clock (and the chain's), and nobody having settled it. */
function overdue() {
  numbers = takenNumbers((content) => {
    const row = taskRow(content.tasks as Record<string, unknown>, TAKEN_SERIAL);
    const past = (content.asOf as { time: number }).time - 10;
    row.deadline = past;
    row.expiresAt = past;
  });
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: STRANGER_EVM,
    answers: sceneAnswers(numbers) as never,
  });
  return planTask({ usd: 400 });
}

function chainSays(over: Partial<ChainTask>) {
  Object.assign(
    chain.answers,
    sceneAnswers(numbers, {
      rows: queueOf(numbers).list.map((r) =>
        r.serial === BigInt(TAKEN_SERIAL) ? { ...r, ...over } : r,
      ),
    }),
  );
}

async function openSheet() {
  fireEvent.click(await screen.findByTestId("return-open"));
  return screen.findByTestId("return-words");
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  forgetPending(
    sendKey(
      `return-task:${numbers.chainId}:${numbers.contracts.treasury}:${TAKEN_SERIAL}`,
      STRANGER_EVM,
    ),
  );
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  localStorage.clear();
  applyServerSettings(null);
});

describe("who sees the press to return the money", () => {
  it("anyone, on a task taken and past its deadline, with the date and that nobody was paid", async () => {
    const task = overdue();
    wrap(<ReturnOffer {...props(task)} />);
    const row = takenRowOf(numbers);
    expect((await screen.findByTestId("return-line")).textContent).toBe(
      `The deadline passed on ${timeText(row.deadline as number)} and nobody was paid. Anyone can return the money to the project.`,
    );
    expect((await screen.findByTestId("return-open")).textContent).toBe(
      "Return the money",
    );
  });

  it("nobody, on a task still running, a plan nobody took, or one that ended", async () => {
    const task = overdue();
    wrap(<ReturnOffer {...props(task)} />);
    await screen.findByTestId("return-open");
    cleanup();
    // Running: the same row by a clock before its deadline.
    const row = takenRowOf(numbers);
    wrap(
      <ReturnOffer {...props(task, { now: (row.deadline as number) - 100 })} />,
    );
    await settled();
    expect(screen.queryByTestId("return-open")).toBeNull();
    expect(screen.queryByTestId("return-line")).toBeNull();
    cleanup();
    const ended = {
      ...props(task),
      chain: { ...row, state: "returned" as const, returned: row.setAside },
    };
    wrap(<ReturnOffer {...ended} />);
    await settled();
    expect(screen.queryByTestId("return-open")).toBeNull();
    cleanup();
    wrap(<ReturnOffer {...props(task, { chain: null })} />);
    await settled();
    expect(screen.queryByTestId("return-open")).toBeNull();
  });

  it("is mounted with the worker's presses on the card", async () => {
    const task = overdue();
    wrap(<WorkerActions {...props(task)} />);
    expect(await screen.findByTestId("return-open")).toBeTruthy();
  });
});

describe("the Return sheet", () => {
  it("says what was set aside and sends one call for that task, from whoever pressed", async () => {
    const task = overdue();
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    const row = takenRowOf(numbers);
    expect(screen.getByTestId("return-facts").textContent).toMatch(
      /are set aside for it\.$/,
    );
    expect(confirm().textContent).toBe("Return the money");
    expect(screen.getByTestId("sheet-play-money")).toBeTruthy();
    chain.onSend = () =>
      chainSays({ state: "returned", returned: row.setAside });
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.name).toBe("returnTask");
    expect(call?.args).toEqual([row.serial]);
    expect(chain.sent[0]?.from).toBe(STRANGER_EVM);
    expect(
      await screen.findByText("Returned. The money is in the project again."),
    ).toBeTruthy();
  });

  it("says the deadline has not passed on the network yet, with the date, and sends nothing", async () => {
    const task = overdue();
    const later = nowOf(numbers.asOf.time) + 3_600;
    chainSays({ deadline: later, expiresAt: later });
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    expect((await screen.findByTestId("return-blocked")).textContent).toBe(
      `This task is not past its deadline yet. The money can be returned from ${timeText(later)}. Nothing changed.`,
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("says the money is not waiting to be returned when the network already ended the task", async () => {
    const task = overdue();
    chainSays({ state: "returned", returned: takenRowOf(numbers).setAside });
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    expect((await screen.findByTestId("return-blocked")).textContent).toBe(
      "The money of this task is not waiting to be returned: it is ran out. Nothing changed.",
    );
    expect(confirm().disabled).toBe(true);
  });

  it("looks again right before the send: a task settled meanwhile is not returned twice", async () => {
    const task = overdue();
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    chainSays({ state: "returned", returned: takenRowOf(numbers).setAside });
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking: it is now ran out/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("a double press sends one call", async () => {
    const task = overdue();
    chain.holdReceipts = true;
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("a send that went out but has not landed is looked for, not sent again: a task found returned is the step that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const task = overdue();
    chain.holdReceipts = true;
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("return-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("return-sheet")).toBeNull(),
    );
    chainSays({ state: "lapsed", returned: takenRowOf(numbers).setAside });
    fireEvent.click(await screen.findByTestId("return-open"));
    await screen.findByTestId("return-words");
    expect(screen.queryByTestId("return-blocked")).toBeNull();
    expect(confirm().textContent).toBe("Look for your return");
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(screen.queryByTestId("return-sheet")).toBeNull(),
    );
    expect(chain.sent).toHaveLength(1);
  }, 20_000);

  it("goes to the wrong-network gate when the wallet is on another network, and has no press", async () => {
    const task = overdue();
    chain.chain = "0x1";
    wrap(<ReturnOffer {...props(task)} />);
    expect(await screen.findByTestId("pot-wrong-network")).toBeTruthy();
    expect(screen.queryByTestId("return-open")).toBeNull();
  });

  it("is a dialog, and Escape gives focus back to the button that opened it", async () => {
    const task = overdue();
    wrap(<ReturnOffer {...props(task)} />);
    const opener = await screen.findByTestId("return-open");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("return-words");
    expect(
      screen.getByRole("dialog").getAttribute("aria-labelledby"),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("return-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("return-sheet")).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByTestId("return-open"));
  });

  it("says in words a refusal from the network", async () => {
    const task = overdue();
    wrap(<ReturnOffer {...props(task)} />);
    await openSheet();
    chain.refuse = `execution reverted: NotYet(${nowOf(numbers.asOf.time)})`;
    fireEvent.click(confirm());
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).not.toMatch(/NotYet/);
    expect(problem.textContent).toMatch(/Nothing changed|did not go through/);
  });
});
