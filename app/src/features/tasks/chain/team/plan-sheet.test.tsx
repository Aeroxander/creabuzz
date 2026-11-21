// The team plans the pay of a task: the door sentence and press on the card, the sheet that reads the network when it
// opens, the numbers on it that are the numbers in the one call, the blocks that stop the press, one signature per press,
// a double press that cannot send twice, a send that may have landed that is looked for before anything is sent again, a
// Pair that asks the other signer, and the keyboard.
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
} from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  planRow,
  planTask,
  queueOf,
  sceneAnswers,
  sceneNumbers,
  TASK_ID,
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../../../money/numbers";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import type { TaskSlotProps } from "../slot-props";
import { chainRowOf, nowOf } from "../state";
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

/** The pay's share of the project's money with the tenth more, as the contract's maths and the sheet both read it. */
function shareOf(usd: number, pot: bigint): number {
  return Number((BigInt(usd) * 1_000_000n * 11_000n + pot - 1n) / pot);
}

function props(
  over: Partial<TaskSlotProps> & { task?: ProjectTask } = {},
): TaskSlotProps {
  const task = over.task ?? planTask();
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

function setup(
  options: {
    patch?: (content: Record<string, unknown>) => void;
    answers?: Parameters<typeof sceneAnswers>[1];
  } = {},
) {
  numbers = sceneNumbers(options.patch);
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: FOUNDER_EVM,
    answers: sceneAnswers(numbers, options.answers) as never,
  });
}

const show = (over: Parameters<typeof props>[0] = {}) =>
  wrap(<TeamActions {...props(over)} />);

async function openSheet() {
  fireEvent.click(await screen.findByTestId("door-plan"));
  await screen.findByTestId("plan-notice");
}

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

describe("the door on the card", () => {
  it("proposes a plan when the pay is more than the box can hold, and says why", async () => {
    setup();
    show();
    const sentence = await screen.findByTestId("door-sentence");
    expect(sentence.getAttribute("data-door")).toBe("plan");
    expect(sentence.textContent).toMatch(
      /more than the allowance box can hold/,
    );
    // The sentence is shown beside the press, always.
    expect((sentence as HTMLElement).hidden).toBe(false);
    expect((await screen.findByTestId("door-plan")).textContent).toBe(
      "Plan the pay of 100 dollars",
    );
  });

  it("offers only the box, with the sentence, to a payee who runs the project; no plan press", async () => {
    setup();
    show({ task: planTask({ payTo: numbers.runner.address }) });
    const sentence = await screen.findByTestId("door-sentence");
    expect(sentence.getAttribute("data-door")).toBe("box-only");
    expect(sentence.textContent).toMatch(/cannot be planned/);
    expect(screen.queryByTestId("door-plan")).toBeNull();
    expect(screen.queryByTestId("door-plan-also")).toBeNull();
  });

  it("says a pay too big for one task is too big, with no press", async () => {
    setup();
    // More than 4.5% of the project's money.
    const big = Number((numbers.money.pot * 5n) / 100n / 1_000_000n) + 1;
    show({ task: planTask({ usd: big }) });
    const sentence = await screen.findByTestId("door-sentence");
    expect(sentence.getAttribute("data-door")).toBe("too-big");
    expect(screen.queryByTestId("door-plan")).toBeNull();
  });

  it("keeps the box as the door for a small pay, and still offers the plan as a second way in", async () => {
    setup();
    show({ task: planTask({ usd: 5 }) });
    const sentence = await screen.findByTestId("door-sentence");
    expect(sentence.getAttribute("data-door")).toBe("box");
    expect(screen.queryByTestId("door-plan")).toBeNull();
    expect((await screen.findByTestId("door-plan-also")).textContent).toBe(
      "Plan it instead, so holders get notice first.",
    );
  });

  it("is not drawn for someone who does not run the project, for a task nobody has taken, or once the plan is live", async () => {
    setup();
    show({ address: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" });
    expect(screen.queryByTestId("door-choice")).toBeNull();
    cleanup();
    show({ task: planTask({ worker: null, state: "open", payTo: null }) });
    expect(screen.queryByTestId("door-choice")).toBeNull();
    cleanup();
    // A task that is paid has nothing left to pay.
    show({
      task: planTask({ state: "accepted", paidTx: `0x${"ab".repeat(32)}` }),
    });
    expect(screen.queryByTestId("door-choice")).toBeNull();
    cleanup();
    // A plan of this task on the network: the card shows the plan, and no door.
    const live = planRow(numbers);
    show({ chain: live, tasks: { ...queueOf(numbers), list: [live] } });
    expect(screen.queryByTestId("door-choice")).toBeNull();
  });

  it("says a helper who has not said yes yet has named no account, and offers no plan", async () => {
    setup();
    show({
      task: planTask({ openToAnyone: false, state: "offered", payTo: null }),
    });
    expect((await screen.findByTestId("door-waiting")).textContent).toMatch(
      /has not named an account to be paid at.*Ask them to agree to the task first/,
    );
    expect(screen.queryByTestId("door-plan")).toBeNull();
  });

  it("says the worker has not named an account and offers no plan", async () => {
    setup();
    show({ task: planTask({ payTo: null }) });
    expect((await screen.findByTestId("door-waiting")).textContent).toMatch(
      /has not named an account/,
    );
    expect(screen.queryByTestId("door-plan")).toBeNull();
  });
});

describe("the Plan sheet", () => {
  it("reads the network when it opens and shows who is paid, the most, the share, the notice and the dates", async () => {
    setup();
    show();
    await openSheet();
    expect(screen.getByTestId("plan-pay-to").textContent).toContain(
      WORKER_WALLET,
    );
    expect(screen.getByTestId("plan-max").textContent).toContain("100 dollars");
    const share = shareOf(100, numbers.money.pot);
    expect(screen.getByTestId("plan-share").textContent).toBe(
      `at most ${share / 100}% of the project's money; if people take out first, less is set aside`,
    );
    expect(screen.getByTestId("plan-notice").textContent).toMatch(
      /Holders get 14 days notice. It can be taken from /,
    );
    expect(screen.getByTestId("plan-lapse").textContent).toMatch(
      /within 7 days, it lapses and nothing moves/,
    );
    expect(screen.getByTestId("plan-due").textContent).toBe(
      "Once taken, it is due 14 days later.",
    );
    // The share and the room are folded under Details.
    expect(screen.getByTestId("plan-details").textContent).toMatch(
      /a tenth more than the pay's share/,
    );
    expect(screen.getByTestId("sheet-play-money").textContent).toMatch(
      /play money/,
    );
    // The reads happened on opening, from the chain.
    const names = chain.reads.map((r) => r.name);
    for (const name of ["tasks", "nextSerial", "openSerials", "noticeFor"])
      expect(names).toContain(name);
    expect(chain.reads.find((r) => r.name === "noticeFor")?.args).toEqual([
      BigInt(share),
    ]);
  });

  it("sends one call whose numbers are the numbers on the sheet", async () => {
    setup();
    show();
    await openSheet();
    const share = shareOf(100, numbers.money.pot);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const [sent] = chain.sent;
    expect(sent?.to).toBe(numbers.contracts.treasury);
    const call = decodeCall(TREASURY_ABI, sent?.data ?? "");
    expect(call?.name).toBe("announceTask");
    expect(call?.args).toEqual([
      `0x${TASK_ID}`,
      WORKER_WALLET,
      100_000_000n,
      BigInt(share),
    ]);
  });

  it("a double press sends one call", async () => {
    setup();
    chain = installPotChain({
      account: FOUNDER_EVM,
      answers: sceneAnswers(numbers) as never,
    });
    chain.holdReceipts = true;
    show();
    await openSheet();
    const confirm = screen.getByTestId("sheet-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("looks again right before the send: a task planned meanwhile is not planned twice", async () => {
    setup();
    show();
    await openSheet();
    // Someone planned the same task record in the meantime: the network now has it.
    const row = planRow(numbers, { serial: queueOf(numbers).nextSerial });
    Object.assign(
      chain.answers,
      sceneAnswers(numbers, {
        rows: [...queueOf(numbers).list, row],
        nextSerial: row.serial + 1n,
      }),
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(
      /This task is already planned: it can be taken from/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("is blocked, with the sentence and no send, when the network already has a plan of this task at open", async () => {
    const probe = sceneNumbers();
    const row = planRow(probe, { serial: queueOf(probe).nextSerial });
    setup({
      answers: {
        rows: [...queueOf(probe).list, row],
        nextSerial: row.serial + 1n,
      },
    });
    show();
    await openSheet();
    expect(screen.getByTestId("plan-blocked").textContent).toMatch(
      /already planned/,
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("is blocked when the team's last check-in has stopped counting", async () => {
    setup({ answers: { activeEnd: 1 } });
    show();
    await openSheet();
    expect(screen.getByTestId("plan-blocked").textContent).toMatch(
      /has not checked in lately/,
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("is blocked when the record is too old to size the share from", async () => {
    setup({
      patch: (content) => {
        content.builtAt = (content.builtAt as number) - 5_000;
      },
    });
    show();
    await openSheet();
    expect(screen.getByTestId("plan-blocked").textContent).toBe(
      "We could not refresh this project's numbers, so a plan cannot be sized now. Try again in a moment.",
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says when a plan needs the team to check in again before it can be taken", async () => {
    // The check-in counts for less than the notice and the time to take it.
    setup({ answers: { activeEnd: Math.floor(Date.now() / 1000) + 3_600 } });
    show();
    await openSheet();
    expect(screen.getByTestId("plan-checkin").textContent).toMatch(
      /The team must check in again before then, or this cannot be taken at all/,
    );
  });

  it("says what could not be read, sends nothing, and offers to try again", async () => {
    setup();
    chain.answers.noticeFor = () => {
      throw new Error("node hiccup");
    };
    show();
    fireEvent.click(await screen.findByTestId("door-plan"));
    expect((await screen.findByTestId("plan-read-failed")).textContent).toMatch(
      /Nothing was planned/,
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("a refusal from the chain is said in plain words and the press stays", async () => {
    setup();
    show();
    await openSheet();
    chain.refuse = "execution reverted: TooManyOpen()";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(/most tasks are already planned/);
    expect(problem.textContent).not.toMatch(/TooManyOpen/);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
  });

  it("a send that went out but has not landed is looked for, not sent again, and a plan found on the network is the one that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    chain.holdReceipts = true;
    show();
    await openSheet();
    const before = queueOf(numbers).nextSerial;
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    // The sheet is closed and opened again; the call has landed under another hash after all (no receipt for the one that
    // was sent): the network now has a plan of this task at the next number.
    fireEvent.keyDown(screen.getByTestId("plan-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("plan-sheet")).toBeNull());
    const row = planRow(numbers, { serial: before });
    Object.assign(
      chain.answers,
      sceneAnswers(numbers, {
        rows: [...queueOf(numbers).list, row],
        nextSerial: before + 1n,
      }),
    );
    fireEvent.click(await screen.findByTestId("door-plan"));
    // It says the task is planned, and the press is still there, to look for the send rather than to send.
    expect((await screen.findByTestId("plan-blocked")).textContent).toMatch(
      /already planned/,
    );
    const look = screen.getByTestId("sheet-confirm") as HTMLButtonElement;
    expect(look.textContent).toBe("Look for your plan");
    expect(look.disabled).toBe(false);
    fireEvent.click(look);
    await waitFor(() => expect(screen.queryByTestId("plan-sheet")).toBeNull());
    expect(chain.sent).toHaveLength(1);
  }, 20_000);

  it("a plan that is on the network with no send of ours waiting cannot be pressed at all", async () => {
    // The mirror of the look above: with nothing waiting, "already planned" is a block and the press is off.
    const probe = sceneNumbers();
    const row = planRow(probe, { serial: queueOf(probe).nextSerial });
    setup({
      answers: {
        rows: [...queueOf(probe).list, row],
        nextSerial: row.serial + 1n,
      },
    });
    show();
    await openSheet();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("looks again right before the send: the team's check-in stopped counting meanwhile", async () => {
    setup();
    show();
    await openSheet();
    chain.answers.activeEnd = [1n];
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /has not checked in lately/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("looks again right before the send: eight tasks were planned meanwhile", async () => {
    setup();
    show();
    await openSheet();
    const base = planRow(numbers);
    const rows = Array.from({ length: 8 }, (_, i) => ({
      ...base,
      what: `0x${(i + 8).toString(16).repeat(64)}`,
      serial: BigInt(100 + i),
      expiresAt: numbers.asOf.time + 10 * 86_400,
    }));
    Object.assign(chain.answers, sceneAnswers(numbers, { rows }));
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /most tasks are already planned/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("looks again right before the send: the notice for this plan moved meanwhile", async () => {
    setup();
    show();
    await openSheet();
    chain.answers.noticeFor = [
      BigInt(20 * 86_400),
      BigInt(7 * 86_400),
      BigInt(14 * 86_400),
    ];
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /notice for this plan moved while you were looking/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("Escape closes the sheet, sends nothing, and focus goes back to the button that opened it", async () => {
    setup();
    show();
    const opener = await screen.findByTestId("door-plan");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("plan-notice");
    fireEvent.keyDown(screen.getByTestId("plan-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("plan-sheet")).toBeNull());
    expect(chain.sent).toEqual([]);
    expect(document.activeElement).toBe(screen.getByTestId("door-plan"));
  });

  it("refuses to send when the wallet now shows another account than the one the numbers were read for", async () => {
    setup();
    show();
    await openSheet();
    chain.account = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /different account/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("with a wallet on another network offers the switch and no sheet", async () => {
    setup();
    chain.chain = "0x1";
    show();
    expect(await screen.findByTestId("pot-wrong-network")).toBeTruthy();
    expect(screen.queryByTestId("door-plan")).toBeNull();
  });

  it("with two people running the project asks the other signer through the Pair, in one proposal", async () => {
    setup({
      patch: (content) => {
        content.runner = {
          address: PAIR,
          isPair: true,
          signers: [FOUNDER_EVM, SECOND],
        };
      },
    });
    // The Pair is read for what already waits in it (nothing here) before the ask is made.
    Object.assign(chain.answers, { PROPOSAL_TTL: [86_400n] });
    show();
    await openSheet();
    expect(screen.getByTestId("sheet-confirm").textContent).toBe(
      "Ask the other signer",
    );
    expect(screen.getByTestId("plan-sheet").textContent).toMatch(/run by two/);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const [sent] = chain.sent;
    expect(sent?.to).toBe(PAIR);
    const proposal = decodeCall(PAIR_ABI, sent?.data ?? "");
    expect(proposal?.name).toBe("propose");
    const inner = decodeCall(TREASURY_ABI, String(proposal?.args[1]));
    expect(inner?.name).toBe("announceTask");
    expect(inner?.args[0]).toBe(`0x${TASK_ID}`);
    // Nothing is planned yet: the note says it is asked, not done.
    expect(
      await screen.findByText(
        "Asked. It is planned when the other signer confirms.",
      ),
    ).toBeTruthy();
  });

  it("has a title, a description and labelled facts, and its Details open from the keyboard's summary", async () => {
    setup();
    show();
    await openSheet();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /Plan the pay for/ }),
    ).toBeTruthy();
    expect(screen.getByText("Pay to").tagName).toBe("DT");
    expect(screen.getByText("Up to").tagName).toBe("DT");
    // One owner of each actionable label: one confirm button, one close.
    expect(
      screen.getAllByRole("button", { name: "Plan this task" }),
    ).toHaveLength(1);
    expect(screen.getByText("Details").tagName).toBe("SUMMARY");
  });
});
