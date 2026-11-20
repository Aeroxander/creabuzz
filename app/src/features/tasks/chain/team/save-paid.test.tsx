// Saving that a task was paid, on the team's list: the transaction comes from the network by the task's number and only when
// the network says the task is paid; a payment whose record failed is kept and finished by the next press; and stopping a task
// whose plan was withdrawn is offered, never forced.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { signatureOf } from "@creaton/core/pot/abi-codec.ts";
import { TASK_BOOK_ABI } from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  published,
  relayMock,
  SERVER,
  wrap,
} from "../../../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
} from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  handedInTask,
  queueOf,
  sceneAnswers,
  settled,
  TAKEN_SERIAL,
  takenNumbers,
  takenRowOf,
  TASK_ID,
} from "../../../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../../../money/numbers";
import type { Project } from "../../../project/project-record";
import { forgetPaid, paidNotRecorded, rememberPaid } from "../../paid-journal";
import type { ProjectTask } from "../../task-record";
import type { TaskSlotProps } from "../slot-props";
import { chainRowOf, nowOf } from "../state";
import type { ChainTask } from "../types";
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
const PAID_TX = `0x${"c1".repeat(32)}`;
const OTHER_TX = `0x${"d2".repeat(32)}`;
const RESOLVED = topicOf(
  signatureOf(
    TASK_BOOK_ABI.find(
      (i) => i.type === "event" && i.name === "TaskResolved",
    ) as never,
  ),
);
const serialTopic = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

let chain: PotChain;
let numbers: ProjectNumbers;

function setup(logs: "resolved" | "none" = "resolved") {
  numbers = takenNumbers();
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: FOUNDER_EVM,
    answers: sceneAnswers(numbers) as never,
    logs:
      logs === "none"
        ? []
        : [
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

/** What the signed record says about the paid task, and (for the chain's own answer) the same. */
const paidRow = (over: Partial<ChainTask> = {}): ChainTask => ({
  ...takenRowOf(numbers),
  state: "paid",
  pay: 1_000_000n,
  returned: takenRowOf(numbers).setAside - 1_000_000n,
  resolvedAt: numbers.asOf.time - 60,
  resolvedTx: OTHER_TX,
  ...over,
});

function chainPays() {
  Object.assign(
    chain.answers,
    sceneAnswers(numbers, {
      rows: queueOf(numbers).list.map((r) =>
        r.serial === BigInt(TAKEN_SERIAL) ? paidRow() : r,
      ),
    }),
  );
}

function show(task: ProjectTask, over: Partial<TaskSlotProps> = {}) {
  const queue = queueOf(numbers);
  const slot: TaskSlotProps = {
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
  return wrap(<TeamActions {...slot} />);
}

const tag = (record: unknown, name: string) =>
  (record as { tags: string[][] }).tags.find((t) => t[0] === name)?.[1];

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  published.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  forgetPaid(TASK_ID);
  applyServerSettings(null);
});

describe("a task paid on the network that the team's list does not say is paid", () => {
  it("offers to save it, and writes the transaction the network gives for the task's number, not the one in the row", async () => {
    setup();
    chainPays();
    show(handedInTask(numbers), { chain: paidRow() });
    expect((await screen.findByTestId("save-paid")).textContent).toMatch(
      /paid on the network, but the record on the team's list does not say so yet/,
    );
    // Nothing that would pay or send back is offered beside it.
    expect(screen.queryByTestId("pay-open")).toBeNull();
    expect(screen.queryByTestId("send-back-open")).toBeNull();
    fireEvent.click(screen.getByTestId("save-paid-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(tag(published[0], "task-part")).toBe("confirm");
    expect(tag(published[0], "task-paid")).toBe(PAID_TX);
    expect(tag(published[0], "task-evidence")).toBe("ab".repeat(32));
  });

  it("writes nothing while the network does not show the task as paid, and says so", async () => {
    setup();
    // The record's row says paid (it is minutes old); the chain, read now, does not.
    show(handedInTask(numbers), { chain: paidRow() });
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    expect(
      (await screen.findByTestId("save-paid-problem")).textContent,
    ).toMatch(/does not show this task as paid yet/);
    expect(published).toEqual([]);
  });

  it("falls back to the row's transaction only when the network's log cannot be found", async () => {
    setup("none");
    chainPays();
    show(handedInTask(numbers), { chain: paidRow() });
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(tag(published[0], "task-paid")).toBe(OTHER_TX);
  });

  it("writes nothing when no transaction can be found at all", async () => {
    setup("none");
    chainPays();
    show(handedInTask(numbers), { chain: paidRow({ resolvedTx: null }) });
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    expect(
      (await screen.findByTestId("save-paid-problem")).textContent,
    ).toMatch(/could not be found on the network/);
    expect(published).toEqual([]);
  });

  it("a payment remembered from an earlier press is offered to be saved even while the record's row still says taken", async () => {
    setup();
    chainPays();
    rememberPaid({
      task: TASK_ID,
      handIn: "ab".repeat(32),
      txHash: PAID_TX,
      at: numbers.asOf.time,
    });
    show(handedInTask(numbers));
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(tag(published[0], "task-paid")).toBe(PAID_TX);
    await waitFor(() => expect(paidNotRecorded(TASK_ID)).toBeNull());
  });

  it("while a payment is waiting to be saved nothing that would pay or send back is offered beside it", async () => {
    setup();
    rememberPaid({
      task: TASK_ID,
      handIn: "ab".repeat(32),
      txHash: PAID_TX,
      at: numbers.asOf.time,
    });
    show(handedInTask(numbers));
    await screen.findByTestId("save-paid-press");
    expect(screen.queryByTestId("pay-open")).toBeNull();
    expect(screen.queryByTestId("send-back-open")).toBeNull();
  });

  it("is not offered when the plan on the network does not tie to the task as the team wrote it", async () => {
    setup();
    chainPays();
    // The control: the same paid row, tying, is offered.
    show(handedInTask(numbers), { chain: paidRow() });
    await screen.findByTestId("save-paid-press");
    cleanup();
    show(handedInTask(numbers, { usd: 5 }), { chain: paidRow() });
    await settled();
    expect(screen.queryByTestId("save-paid")).toBeNull();
  });

  it("takes the transaction from this book's log of this task's number, whatever else the node answers", async () => {
    setup();
    chainPays();
    const other = `0x${"e3".repeat(32)}`;
    const mine = (chain.logs as { topics: string[] }[])[0];
    chain.logs = [
      mine,
      // The log of another contract with the same topics, and one of this book for another task: both come after.
      {
        ...mine,
        address: "0x00000000000000000000000000000000000000b2",
        transactionHash: other,
      },
      {
        ...mine,
        topics: [RESOLVED, serialTopic(TAKEN_SERIAL + 1)],
        transactionHash: other,
      },
    ];
    show(handedInTask(numbers), { chain: paidRow() });
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(tag(published[0], "task-paid")).toBe(PAID_TX);
  });

  it("keeps the payment when the record fails, and says what the server said when it has not read the payment yet", async () => {
    setup();
    chainPays();
    vi.spyOn(relayMock, "publishAsUser").mockRejectedValueOnce(
      new Error(
        "retry: the network has not shown this payment to the server yet; try again in a minute",
      ),
    );
    show(handedInTask(numbers), { chain: paidRow() });
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    expect((await screen.findByTestId("save-paid-problem")).textContent).toBe(
      "The payment went through. The server has not read it yet, so the record is not saved. Press again in a few minutes: nothing is paid twice.",
    );
    expect(paidNotRecorded(TASK_ID)?.txHash).toBe(PAID_TX);
    // The next press writes the record and pays nothing.
    fireEvent.click(screen.getByTestId("save-paid-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(chain.sent).toEqual([]);
  });

  it("uses the second confirmation for work that was already accepted with the pay owed", async () => {
    setup();
    chainPays();
    show(
      handedInTask(numbers, {
        state: "accepted",
        acceptedBy: FOUNDER_KEY,
        acceptedAt: numbers.asOf.time - 100,
      }),
      { chain: paidRow() },
    );
    fireEvent.click(await screen.findByTestId("save-paid-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(
      JSON.parse((published[0] as { content: string }).content).title,
    ).toBe("Pay recorded");
  });

  it("is not offered once the team's list says paid, or to someone who does not run the project", async () => {
    setup();
    chainPays();
    // The control: the same paid row with the pay not on the list is offered.
    show(handedInTask(numbers), { chain: paidRow() });
    await screen.findByTestId("save-paid");
    cleanup();
    show(handedInTask(numbers, { state: "accepted", paidTx: OTHER_TX }), {
      chain: paidRow(),
    });
    await settled();
    expect(screen.queryByTestId("save-paid")).toBeNull();
    cleanup();
    show(handedInTask(numbers), {
      chain: paidRow(),
      address: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
    });
    await settled();
    expect(screen.queryByTestId("save-paid")).toBeNull();
  });
});

describe("stopping a task whose plan was withdrawn", () => {
  const withdrawn = (): ChainTask => ({
    ...takenRowOf(numbers),
    state: "cancelled",
    setAside: 0n,
    takenBy: null,
    takenAt: null,
    deadline: null,
    resolvedAt: numbers.asOf.time - 60,
  });

  it("is offered, writes the team's own step with its words, and is never forced", async () => {
    setup();
    const task = handedInTask(numbers, { state: "working", handIn: null });
    show(task, { chain: withdrawn() });
    expect((await screen.findByTestId("stop-task")).textContent).toMatch(
      /The plan was withdrawn on the network/,
    );
    // The step 1 card is still there to use: nothing was removed.
    expect(screen.queryByTestId("pay-open")).toBeNull();
    fireEvent.click(screen.getByTestId("stop-task-press"));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(tag(published[0], "task-part")).toBe("cancel");
    expect(tag(published[0], "task")).toBe(TASK_ID);
    expect(JSON.parse((published[0] as { content: string }).content).note).toBe(
      "The plan for this task was withdrawn.",
    );
  });

  it("is not offered when the task is already stopped on the list, or the plan ended in another way", async () => {
    setup();
    // The control: a withdrawn plan on a task still on the list is offered.
    show(handedInTask(numbers, { state: "working" }), { chain: withdrawn() });
    await screen.findByTestId("stop-task");
    cleanup();
    show(handedInTask(numbers, { state: "cancelled" }), { chain: withdrawn() });
    await settled();
    expect(screen.queryByTestId("stop-task")).toBeNull();
    cleanup();
    show(handedInTask(numbers, { state: "working" }), {
      chain: { ...withdrawn(), state: "lapsed" },
    });
    await settled();
    expect(screen.queryByTestId("stop-task")).toBeNull();
  });
});
