// What stops the team's pay press and what is looked at again right before it: the one sentence of the gate, the network asked
// once more at the press, a send that may have landed looked for and never repeated, and a project run by two.
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
import { published, SERVER } from "../../../../../tests/helpers/money-harness";
import {
  FOUNDER_EVM,
  STRANGER_EVM,
} from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  handedInTask,
  queueOf,
  sceneAnswers,
  settled,
  TAKEN_SERIAL,
  takenRowOf,
  TASK_ID,
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import {
  PAID_TX,
  PAIR,
  SECOND,
  chain,
  numbers,
  setAside,
  show,
  setup,
  chainPays,
  openSheet,
  confirm,
  rowWith,
} from "../../../../../tests/helpers/pay-scene";
import { forgetPaid } from "../../paid-journal";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);

vi.mock("../../use-tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../use-tasks")>()),
  freshTask: async () =>
    (await import("../../../../../tests/helpers/pay-scene")).serverTask(),
}));

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

  it("a task the network shows paid (the other signer's confirmation ran) offers to save that it was paid, and writes the record from the network", async () => {
    setup({ chainRow: { state: "paid", pay: 1_000_000n } });
    show();
    await openSheet();
    fireEvent.click(screen.getByTestId("accept-save-paid"));
    await waitFor(() => expect(published).toHaveLength(1));
    const tags = (published[0] as { tags: string[][] }).tags;
    expect(tags.find((t) => t[0] === "task-paid")?.[1]).toBe(PAID_TX);
    expect(chain.sent).toEqual([]);
  });

  it("offers no saving when the team's list already says paid, or the network does not say the task is paid", async () => {
    setup({ chainRow: { state: "paid", pay: 1_000_000n } });
    // Work accepted with the payment on record: nothing is owed on the list, so the card is not even offering the sheet.
    show({
      task: handedInTask(numbers, {
        state: "accepted",
        paidTx: `0x${"ee".repeat(32)}`,
      }),
    });
    await settled();
    expect(screen.queryByTestId("pay-open")).toBeNull();
    cleanup();
    // A task that is blocked for another reason is not offered a save.
    setup({ chainRow: { takenBy: STRANGER_EVM } });
    show();
    await openSheet();
    expect(screen.getByTestId("accept-blocked")).toBeTruthy();
    expect(screen.queryByTestId("accept-save-paid")).toBeNull();
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
