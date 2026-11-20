// The two presses that end a task without paying anyone: send a taken task's money back, withdraw a plan nobody has taken.
// Each reads the task from the chain when it opens, says why it cannot be pressed, sends one call built from that reading,
// asks the chain again right before the send, never sends twice, and is only offered before the task's end.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { PAIR_ABI, TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
  STRANGER_EVM,
} from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  handedInTask,
  PLANNED_SERIAL,
  planTask,
  plannedNumbers,
  plannedRowOf,
  queueOf,
  sceneAnswers,
  settled,
  TAKEN_SERIAL,
  takenNumbers,
  takenRowOf,
} from "../../../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../../../money/numbers";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import type { TaskSlotProps } from "../slot-props";
import { chainRowOf, nowOf } from "../state";
import type { ChainTask } from "../types";
import { PlanOnlyCard } from "./PlanOnlyCard";
import { TeamActions } from "./TeamActions";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;
const PAIR = "0x00000000000000000000000000000000000000ff";
const SECOND = "0x00000000000000000000000000000000000000dd";

let chain: PotChain;
let numbers: ProjectNumbers;

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

/** The chain says something other than the record about the row with this serial. */
function chainSays(serial: number, over: Partial<ChainTask>) {
  Object.assign(
    chain.answers,
    sceneAnswers(numbers, {
      rows: queueOf(numbers).list.map((r) =>
        r.serial === BigInt(serial) ? { ...r, ...over } : r,
      ),
    }),
  );
}

function taken(patch?: (content: Record<string, unknown>) => void) {
  numbers = takenNumbers(patch);
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: FOUNDER_EVM,
    answers: sceneAnswers(numbers) as never,
  });
  return handedInTask(numbers, { state: "working", handIn: null });
}

function planned(patch?: (content: Record<string, unknown>) => void) {
  numbers = plannedNumbers(patch);
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: FOUNDER_EVM,
    answers: sceneAnswers(numbers) as never,
  });
  return planTask({
    usd: Number(plannedRowOf(numbers).maxDollars / 1_000_000n),
  });
}

const confirm = () => screen.getByTestId("sheet-confirm") as HTMLButtonElement;

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  localStorage.clear();
  applyServerSettings(null);
});

describe("send the money back", () => {
  it("is offered on a taken task, says what happens, and sends one call for that task", async () => {
    const task = taken();
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    const words = screen.getByTestId("send-back-words").textContent;
    expect(words).toMatch(
      /^Nobody is paid\. All \d[\d.,]* dollars go back to the project and to the people who took out while it was set aside\.$/,
    );
    expect(screen.getByTestId("send-back-sheet").textContent).toMatch(
      /does not use up the room the project has for tasks/,
    );
    expect(confirm().textContent).toBe("Send the money back");
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.name).toBe("rejectTask");
    expect(call?.args).toEqual([BigInt(TAKEN_SERIAL)]);
    expect(
      await screen.findByText(
        /Sent back\. The money is in the project again\./,
      ),
    ).toBeTruthy();
  });

  it("is offered after the relay worker gave up or handed in nothing", async () => {
    const task = taken();
    wrap(<TeamActions {...props({ ...task, state: "given-up" })} />);
    expect(await screen.findByTestId("send-back-open")).toBeTruthy();
  });

  it("is not offered after the deadline by the card's clock either", async () => {
    const task = taken();
    const row = takenRowOf(numbers);
    // Positive control: before the deadline it is offered.
    wrap(<TeamActions {...props(task)} />);
    await screen.findByTestId("send-back-open");
    cleanup();
    wrap(<TeamActions {...props(task, { now: (row.deadline ?? 0) + 1 })} />);
    await settled();
    expect(screen.queryByTestId("send-back-open")).toBeNull();
    expect(screen.queryByTestId("pay-open")).toBeNull();
  });

  it("is not offered after the deadline, and the sheet says so if the deadline passes while it is open", async () => {
    const task = taken();
    const row = takenRowOf(numbers);
    // Offered by the record's clock; the chain's clock has passed the deadline by the time the sheet opens.
    chain.blockTime = (row.deadline ?? 0) + 5;
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    expect((await screen.findByTestId("step-blocked")).textContent).toMatch(
      /The deadline has passed, so this task ends by itself/,
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("says a task that is not holding money is not holding money", async () => {
    const task = taken();
    wrap(<TeamActions {...props(task)} />);
    chainSays(TAKEN_SERIAL, { state: "rejected", returned: 1n });
    fireEvent.click(await screen.findByTestId("send-back-open"));
    expect((await screen.findByTestId("step-blocked")).textContent).toBe(
      "This task is not holding money: sent back.",
    );
    expect(confirm().disabled).toBe(true);
  });

  it("looks again right before the send: a task paid meanwhile is not sent back", async () => {
    const task = taken();
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    chainSays(TAKEN_SERIAL, { state: "paid", pay: 1_000_000n });
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking: it is now already paid/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("looks again right before the send: the deadline passed meanwhile", async () => {
    const task = taken();
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    chain.blockTime = (takenRowOf(numbers).deadline ?? 0) + 5;
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /The deadline has passed/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("a double press sends one call", async () => {
    const task = taken();
    chain.holdReceipts = true;
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("a send that went out but has not landed is looked for, not sent again: a task found sent back is the step that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const task = taken();
    chain.holdReceipts = true;
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("send-back-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("send-back-sheet")).toBeNull(),
    );
    chainSays(TAKEN_SERIAL, { state: "rejected", returned: 1n });
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    // "Not holding money" is the step having landed: no block, and the press looks for it instead of sending.
    expect(screen.queryByTestId("step-blocked")).toBeNull();
    expect(confirm().textContent).toBe("Look for your step");
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(screen.queryByTestId("send-back-sheet")).toBeNull(),
    );
    expect(chain.sent).toHaveLength(1);
  }, 20_000);

  it("with two people running the project asks the other signer", async () => {
    const task = taken((content) => {
      content.runner = {
        address: PAIR,
        isPair: true,
        signers: [FOUNDER_EVM, SECOND],
      };
    });
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    expect(confirm().textContent).toBe("Ask the other signer");
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    expect(chain.sent[0]?.to).toBe(PAIR);
    const proposal = decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "");
    const inner = decodeCall(TREASURY_ABI, String(proposal?.args[1]));
    expect(inner?.name).toBe("rejectTask");
    expect(inner?.args).toEqual([BigInt(TAKEN_SERIAL)]);
  });

  it("Escape closes it and focus goes back to the button that opened it", async () => {
    const task = taken();
    wrap(<TeamActions {...props(task)} />);
    const opener = await screen.findByTestId("send-back-open");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("send-back-words");
    fireEvent.keyDown(screen.getByTestId("send-back-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("send-back-sheet")).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByTestId("send-back-open"));
  });
});

describe("withdraw a plan", () => {
  it("is offered on a plan nobody has taken, says what happens, and sends one call for that task", async () => {
    const task = planned();
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    await screen.findByTestId("withdraw-words");
    expect(screen.getByTestId("withdraw-words").textContent).toBe(
      "Nobody has taken it, so no money moves. The task stays on your list and can be planned again.",
    );
    expect(confirm().textContent).toBe("Withdraw the plan");
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.name).toBe("cancelTask");
    expect(call?.args).toEqual([BigInt(PLANNED_SERIAL)]);
    expect(await screen.findByText("Withdrawn.")).toBeTruthy();
  });

  it("is not offered once the plan's time is up: it lapses by itself", async () => {
    const task = planned();
    const row = plannedRowOf(numbers);
    // Positive control: before its end the same plan is offered for withdrawal.
    wrap(<TeamActions {...props(task)} />);
    await screen.findByTestId("withdraw-open");
    cleanup();
    wrap(<TeamActions {...props(task, { now: row.expiresAt + 1 })} />);
    await settled();
    expect(screen.queryByTestId("withdraw-open")).toBeNull();
  });

  it("says the plan's time is up if the chain's clock passed its end while the sheet was open, and sends nothing", async () => {
    const task = planned();
    wrap(<TeamActions {...props(task)} />);
    chain.blockTime = (plannedRowOf(numbers).expiresAt ?? 0) + 5;
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    expect((await screen.findByTestId("step-blocked")).textContent).toBe(
      "The time for this plan is over, so it lapses by itself and nothing moves.",
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("says a task that was taken meanwhile cannot be withdrawn, and sends nothing", async () => {
    const task = planned();
    wrap(<TeamActions {...props(task)} />);
    chainSays(PLANNED_SERIAL, {
      state: "taken",
      takenBy: STRANGER_EVM,
      takenAt: numbers.asOf.time,
      deadline: numbers.asOf.time + 86_400,
      setAside: 5_000_000n,
    });
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    expect((await screen.findByTestId("step-blocked")).textContent).toBe(
      "Someone has taken this task. Send the money back instead.",
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("looks again right before the send: a plan taken meanwhile is not withdrawn", async () => {
    const task = planned();
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    await screen.findByTestId("withdraw-words");
    chainSays(PLANNED_SERIAL, {
      state: "taken",
      takenBy: STRANGER_EVM,
      takenAt: numbers.asOf.time,
      deadline: numbers.asOf.time + 86_400,
      setAside: 5_000_000n,
    });
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking: it is now taken/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("is not offered to someone who does not run the project", async () => {
    const task = planned();
    wrap(<TeamActions {...props(task, { address: STRANGER_EVM })} />);
    await settled();
    expect(screen.queryByTestId("withdraw-open")).toBeNull();
  });

  it("with two people running the project asks the other signer", async () => {
    const task = planned((content) => {
      content.runner = {
        address: PAIR,
        isPair: true,
        signers: [FOUNDER_EVM, SECOND],
      };
    });
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    await screen.findByTestId("withdraw-words");
    expect(confirm().textContent).toBe("Ask the other signer");
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const proposal = decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "");
    const inner = decodeCall(TREASURY_ABI, String(proposal?.args[1]));
    expect(inner?.name).toBe("cancelTask");
    expect(
      await screen.findByText(
        /Asked\. It is withdrawn when the other signer confirms\./,
      ),
    ).toBeTruthy();
  });

  it("a send that went out but has not landed is looked for, not sent again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const task = planned();
    chain.holdReceipts = true;
    wrap(<TeamActions {...props(task)} />);
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    await screen.findByTestId("withdraw-words");
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("withdraw-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("withdraw-sheet")).toBeNull(),
    );
    chainSays(PLANNED_SERIAL, { state: "cancelled" });
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    await screen.findByTestId("withdraw-words");
    expect(screen.queryByTestId("step-blocked")).toBeNull();
    expect(confirm().textContent).toBe("Look for your step");
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(screen.queryByTestId("withdraw-sheet")).toBeNull(),
    );
    expect(chain.sent).toHaveLength(1);
  }, 20_000);
});

describe("a plan with no task record here", () => {
  const card = (row: ChainTask, address: string | null = FOUNDER_EVM) =>
    wrap(
      <PlanOnlyCard
        address={address}
        ageNote={null}
        now={nowOf(numbers.asOf.time)}
        numbers={numbers}
        row={row}
        windDownAt={null}
      />,
    );

  it("the person who runs the project can withdraw it, and the sheet says it is for a task it cannot name", async () => {
    planned();
    card(plannedRowOf(numbers));
    fireEvent.click(await screen.findByTestId("withdraw-open"));
    await screen.findByTestId("withdraw-words");
    expect(
      screen.getByRole("heading", { name: "Withdraw the plan for a task" }),
    ).toBeTruthy();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    expect(decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "")?.args).toEqual([
      BigInt(PLANNED_SERIAL),
    ]);
  });

  it("a taken one can have its money sent back", async () => {
    taken();
    card(takenRowOf(numbers));
    fireEvent.click(await screen.findByTestId("send-back-open"));
    await screen.findByTestId("send-back-words");
    expect(
      screen.getByRole("heading", { name: "Send the money back for a task" }),
    ).toBeTruthy();
  });

  it("nobody else is offered either, and nothing is offered after the end", async () => {
    planned();
    // Positive control: the person who runs the project is offered it.
    card(plannedRowOf(numbers));
    await screen.findByTestId("withdraw-open");
    cleanup();
    card(plannedRowOf(numbers), STRANGER_EVM);
    await settled();
    expect(screen.queryByTestId("withdraw-open")).toBeNull();
    cleanup();
    wrap(
      <PlanOnlyCard
        address={FOUNDER_EVM}
        ageNote={null}
        now={plannedRowOf(numbers).expiresAt + 1}
        numbers={numbers}
        row={plannedRowOf(numbers)}
        windDownAt={null}
      />,
    );
    await settled();
    expect(screen.queryByTestId("withdraw-open")).toBeNull();
  });
});
