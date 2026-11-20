// The team pays for handed-in work on the network: the sheet reads the task from the chain when it opens, says in one sentence
// why it cannot be pressed, pays in full or in part to the wallet that took the task and to nobody else, asks the chain again
// right before the send, never sends twice, and writes the team's record from the payment the chain gives for the task's number.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall, signatureOf } from "@creaton/core/pot/abi-codec.ts";
import {
  PAIR_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  published,
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
  STRANGER_EVM,
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
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../../../money/numbers";
import type { Project } from "../../../project/project-record";
import { forgetPaid, paidNotRecorded } from "../../paid-journal";
import type { ProjectTask } from "../../task-record";
import type { TaskSlotProps } from "../slot-props";
import { chainRowOf, nowOf } from "../state";
import type { ChainTask } from "../types";
import { exactPhrase } from "./pay-words";
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
const PAID_TX = `0x${"c1".repeat(32)}`;
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
let setAside: bigint;

function props(
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
const rowWith = (over: Partial<ChainTask>): ChainTask => ({
  ...takenRowOf(numbers),
  ...over,
});

function setup(
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
function chainPays(pay: bigint) {
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

const show = (over: Parameters<typeof props>[0] = {}) =>
  wrap(<TeamActions {...props(over)} />);

async function openSheet() {
  fireEvent.click(await screen.findByTestId("pay-open"));
  await screen.findByTestId("accept-pay-to");
}

const confirm = () => screen.getByTestId("sheet-confirm") as HTMLButtonElement;

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  published.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  localStorage.clear();
  forgetPaid(TASK_ID);
  applyServerSettings(null);
});

describe("the card of a task that is taken on the network", () => {
  it("offers to pay for the work and to send the money back, and nothing to plan", async () => {
    setup();
    show();
    expect((await screen.findByTestId("pay-open")).textContent).toBe(
      "Pay for the work",
    );
    expect(screen.getByTestId("send-back-open").textContent).toBe(
      "Send the money back",
    );
    expect(screen.queryByTestId("door-choice")).toBeNull();
    expect(screen.queryByTestId("withdraw-open")).toBeNull();
  });

  it("offers only to send the money back while the work is not handed in", async () => {
    setup();
    show({ task: handedInTask(numbers, { state: "working", handIn: null }) });
    await screen.findByTestId("send-back-open");
    expect(screen.queryByTestId("pay-open")).toBeNull();
    cleanup();
    // A record that says work was handed in but names no piece has nothing to pay against.
    show({ task: handedInTask(numbers, { handIn: null }) });
    await screen.findByTestId("send-back-open");
    expect(screen.queryByTestId("pay-open")).toBeNull();
  });

  it("offers nothing to anyone who does not run the project", async () => {
    setup();
    show({ address: STRANGER_EVM });
    await settled();
    expect(screen.queryByTestId("pay-presses")).toBeNull();
    expect(screen.queryByTestId("pay-open")).toBeNull();
    expect(screen.queryByTestId("send-back-open")).toBeNull();
  });

  it("offers nothing once the deadline has passed: the network ends the task by itself", async () => {
    setup();
    const late = numbers.asOf.time + 30 * 86_400;
    // Positive control: the same card before the deadline offers both.
    show();
    await screen.findByTestId("pay-open");
    cleanup();
    show({ now: late });
    await settled();
    expect(screen.queryByTestId("pay-presses")).toBeNull();
  });
});

describe("the pay sheet", () => {
  it("reads the task from the network when it opens and shows who is paid and what is set aside", async () => {
    setup();
    show();
    await openSheet();
    expect(screen.getByTestId("accept-pay-to").textContent).toContain(
      WORKER_WALLET,
    );
    expect(screen.getByTestId("accept-set-aside").textContent).toMatch(
      /^\d[\d,.]* dollars, due /,
    );
    expect(chain.reads.map((r) => r.name)).toEqual(
      expect.arrayContaining(["tasks", "taskOf"]),
    );
    expect(chain.reads.find((r) => r.name === "taskOf")?.args).toEqual([
      BigInt(TAKEN_SERIAL),
    ]);
    expect(screen.getByTestId("sheet-play-money").textContent).toMatch(
      /play money/,
    );
    expect(confirm().textContent).toBe(`Pay ${exactPhrase(setAside)}`);
  });

  it("pays all of it by one call to the wallet that took the task, and the call has no recipient", async () => {
    setup();
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const [sent] = chain.sent;
    expect(sent?.to).toBe(numbers.contracts.treasury);
    const call = decodeCall(TREASURY_ABI, sent?.data ?? "");
    expect(call?.name).toBe("acceptTask");
    expect(call?.args).toEqual([BigInt(TAKEN_SERIAL), setAside]);
  });

  it("pays part: the amount typed is what the call carries, and the sheet says what goes back", async () => {
    setup();
    show();
    await openSheet();
    fireEvent.click(screen.getByTestId("accept-part"));
    fireEvent.change(await screen.findByTestId("accept-amount"), {
      target: { value: "12.50" },
    });
    expect(confirm().textContent).toBe("Pay 12.50 dollars");
    expect(screen.getByTestId("accept-left").textContent).toMatch(
      /What is left goes back to the project and to the people who took out while it was set aside\. \d[\d.,]* dollars go back\./,
    );
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.args).toEqual([BigInt(TAKEN_SERIAL), 12_500_000n]);
  });

  it.each([
    ["", /Type how much to pay/],
    ["abc", /numbers only/],
    ["0.50", /at least 1 dollar/],
    ["12.345", /dollars and cents/],
    ["1000000", /at most/],
  ])("does not let %j be pressed: it says what is wrong", async (typed, words) => {
    setup();
    show();
    await openSheet();
    fireEvent.click(screen.getByTestId("accept-part"));
    fireEvent.change(await screen.findByTestId("accept-amount"), {
      target: { value: typed },
    });
    expect(confirm().disabled).toBe(true);
    if (typed !== "") expect(screen.getByText(words)).toBeTruthy();
    expect(chain.sent).toEqual([]);
  });

  it("a double press sends one call", async () => {
    setup();
    chain.holdReceipts = true;
    show();
    await openSheet();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("a payment that landed writes the team's record with the transaction the network gives for this task's number", async () => {
    setup();
    chain.onSend = () => chainPays(setAside);
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(published).toHaveLength(1));
    const record = published[0] as { tags: string[][] };
    const tag = (name: string) => record.tags.find((t) => t[0] === name)?.[1];
    expect(tag("task-part")).toBe("confirm");
    expect(tag("task-paid")).toBe(PAID_TX);
    expect(tag("task-evidence")).toBe("ab".repeat(32));
    // The transaction is not the hash the wallet gave for the send.
    expect(chain.sent).toHaveLength(1);
    expect(PAID_TX).not.toBe(`0x${"1".padStart(64, "0")}`);
    // Once the record is on the server the remembered payment is forgotten.
    await waitFor(() => expect(paidNotRecorded(TASK_ID)).toBeNull());
  });

  it("for work already accepted with the pay owed, the record is a second confirmation of the same piece", async () => {
    setup();
    chain.onSend = () => chainPays(setAside);
    show({
      task: handedInTask(numbers, {
        state: "accepted",
        acceptedBy: FOUNDER_KEY,
        acceptedAt: numbers.asOf.time - 100,
      }),
    });
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(published).toHaveLength(1));
    const record = published[0] as { tags: string[][]; content: string };
    expect(JSON.parse(record.content).title).toBe("Pay recorded");
    expect(record.tags.find((t) => t[0] === "task-paid")?.[1]).toBe(PAID_TX);
  });

  it("does not write a record when the network cannot say which transaction paid", async () => {
    setup();
    chain.logs = [];
    chain.onSend = () => chainPays(setAside);
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(published).toEqual([]);
  });
});

describe("what stops the pay press, in one sentence", () => {
  it("a task the network says is not taken any more", async () => {
    setup({ chainRow: { state: "paid", pay: 1_000_000n } });
    show();
    await openSheet();
    expect(screen.getByTestId("accept-blocked").textContent).toMatch(
      /not waiting for payment on the network: already paid/,
    );
    expect(screen.queryByTestId("accept-all")).toBeNull();
    expect(confirm().disabled).toBe(true);
  });

  it("a wallet that took it that is not the wallet the worker named, and offers to send the money back", async () => {
    setup({ chainRow: { takenBy: STRANGER_EVM } });
    show();
    await openSheet();
    const blocked = screen.getByTestId("accept-blocked").textContent ?? "";
    expect(blocked).toContain(STRANGER_EVM);
    expect(blocked).toContain(WORKER_WALLET);
    // The wallet shown as the one that took it is the network's, read now, not the record's row.
    const taker = screen.getByTestId("accept-pay-to").textContent ?? "";
    expect(taker).toContain(STRANGER_EVM);
    expect(taker).not.toContain(WORKER_WALLET);
    expect(confirm().disabled).toBe(true);
    expect(screen.getByTestId("accept-send-back")).toBeTruthy();
  });

  it("a deadline too close to pay safely", async () => {
    setup();
    const row = takenRowOf(numbers);
    chain.blockTime = (row.deadline ?? 0) - 30;
    show();
    await openSheet();
    expect(screen.getByTestId("accept-blocked").textContent).toMatch(
      /too close to pay this safely/,
    );
    expect(confirm().disabled).toBe(true);
  });

  it("a pay on the team's list that is not what was planned", async () => {
    setup();
    show({ task: handedInTask(numbers, { usd: 5 }) });
    await openSheet();
    expect(screen.getByTestId("accept-blocked").textContent).toMatch(
      /not for this task as it was written here \(the pay is not the same\)/,
    );
    expect(confirm().disabled).toBe(true);
  });

  it("a plan that was made more than once on the network: only the first can be paid", async () => {
    setup({ chainRow: { repeatOf: 2n } });
    // The record's own row is the one shown; the fresh reading carries what the record's history knows.
    const queue = queueOf(numbers);
    const shown = { ...takenRowOf(numbers), repeatOf: 2n };
    show({ chain: shown, tasks: { ...queue, list: [shown] } });
    await openSheet();
    expect(screen.getByTestId("accept-blocked").textContent).toMatch(
      /planned more than once on the network \(task 2 came first\)/,
    );
  });

  it("the work being the sender's own", async () => {
    setup();
    // Someone else on the team could accept it, so the founder may not check their own work.
    show({
      task: handedInTask(numbers, { worker: FOUNDER_KEY }),
      team: new Set([FOUNDER_KEY, "e".repeat(64)]),
    });
    await openSheet();
    expect(screen.getByTestId("accept-blocked").textContent).toMatch(
      /done by you or by an agent you run/,
    );
  });

  it("a wallet that does not run the project", async () => {
    setup();
    chain.account = STRANGER_EVM;
    show();
    // The card still thinks the signed-in person's wallet is the runner's; the sheet reads the wallet it has now.
    await openSheet();
    expect(screen.getByTestId("accept-blocked").textContent).toMatch(
      /Only the wallet that runs this project/,
    );
  });

  it("a read that failed: nothing can be sent and the press is off", async () => {
    setup();
    chain.answers.taskOf = () => {
      throw new Error("node hiccup");
    };
    show();
    fireEvent.click(await screen.findByTestId("pay-open"));
    expect(
      (await screen.findByTestId("accept-read-failed")).textContent,
    ).toMatch(/Nothing was paid/);
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });
});

describe("looking again right before the send", () => {
  it("the task was paid meanwhile: nothing is sent", async () => {
    setup();
    show();
    await openSheet();
    chainPays(setAside);
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /This task changed while you were looking: it is now already paid/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("the money set aside changed meanwhile: nothing is sent", async () => {
    setup();
    show();
    await openSheet();
    Object.assign(
      chain.answers,
      sceneAnswers(numbers, {
        rows: queueOf(numbers).list.map((r) =>
          r.serial === BigInt(TAKEN_SERIAL)
            ? rowWith({ setAside: setAside - 1n })
            : r,
        ),
      }),
    );
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("the deadline came too close meanwhile, though the task itself did not change: nothing is sent", async () => {
    setup();
    show();
    await openSheet();
    chain.blockTime = (takenRowOf(numbers).deadline ?? 0) - 30;
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /too close to pay this safely/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("the account in the wallet changed: nothing is sent", async () => {
    setup();
    show();
    await openSheet();
    chain.account = STRANGER_EVM;
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /different account/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("a send that went out but has not landed is looked for, not sent again, and a task found paid is the payment that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    chain.holdReceipts = true;
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("accept-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("accept-sheet")).toBeNull(),
    );
    // It landed under another hash after all: the network now has the task paid.
    chainPays(setAside);
    fireEvent.click(await screen.findByTestId("pay-open"));
    await screen.findByTestId("accept-pay-to");
    // The sentence "not waiting for payment" is the send having landed; the press is still there, to look and not to send.
    expect(screen.queryByTestId("accept-blocked")).toBeNull();
    const look = confirm();
    expect(look.textContent).toBe("Look for your payment");
    expect(look.disabled).toBe(false);
    fireEvent.click(look);
    await waitFor(() =>
      expect(screen.queryByTestId("accept-sheet")).toBeNull(),
    );
    expect(chain.sent).toHaveLength(1);
  }, 20_000);

  it("a task paid with no send of ours waiting cannot be pressed at all", async () => {
    setup({ chainRow: { state: "paid", pay: 1_000_000n } });
    show();
    await openSheet();
    expect(confirm().disabled).toBe(true);
  });
});

describe("with two people running the project", () => {
  it("asks the other signer through the Pair in one proposal of the same call, and writes no record yet", async () => {
    setup({
      patch: (content) => {
        content.runner = {
          address: PAIR,
          isPair: true,
          signers: [FOUNDER_EVM, SECOND],
        };
      },
    });
    // A world where the chain already says paid after the proposal: the proposal alone still writes no record (only a payment
    // that landed does).
    chain.onSend = () => chainPays(setAside);
    show();
    await openSheet();
    expect(confirm().textContent).toBe("Ask the other signer");
    expect(screen.getByTestId("accept-sheet").textContent).toMatch(
      /run by two/,
    );
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const [sent] = chain.sent;
    expect(sent?.to).toBe(PAIR);
    const proposal = decodeCall(PAIR_ABI, sent?.data ?? "");
    expect(proposal?.name).toBe("propose");
    const inner = decodeCall(TREASURY_ABI, String(proposal?.args[1]));
    expect(inner?.name).toBe("acceptTask");
    expect(inner?.args).toEqual([BigInt(TAKEN_SERIAL), setAside]);
    expect(
      await screen.findByText(
        "Asked. It is paid when the other signer confirms.",
      ),
    ).toBeTruthy();
    await settled();
    expect(published).toEqual([]);
  });
});

describe("keyboard, focus and names", () => {
  it("Escape closes the sheet, sends nothing, and focus goes back to the button that opened it", async () => {
    setup();
    show();
    const opener = await screen.findByTestId("pay-open");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("accept-pay-to");
    fireEvent.keyDown(screen.getByTestId("accept-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("accept-sheet")).toBeNull(),
    );
    expect(chain.sent).toEqual([]);
    expect(document.activeElement).toBe(screen.getByTestId("pay-open"));
  });

  it("the choice is a group with a legend and radios, the amount has its label, and each press has one owner of its name", async () => {
    setup();
    show();
    await openSheet();
    const group = screen.getByRole("group", { name: "How much to pay" });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /^Pay all / })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Pay part" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Amount to pay, in dollars" }),
      { target: { value: "5" } },
    );
    expect(screen.getByText("Pay to").tagName).toBe("DT");
    expect(screen.getByText("Set aside").tagName).toBe("DT");
    expect(screen.getAllByRole("button", { name: /^Pay \d/ })).toHaveLength(1);
  });
});
