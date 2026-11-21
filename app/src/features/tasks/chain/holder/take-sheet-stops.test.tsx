import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { wrap } from "../../../../../tests/helpers/money-harness";
import { STRANGER_EVM } from "../../../../../tests/helpers/pot-harness";
import {
  plannedRowOf,
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import {
  chain,
  chainSays,
  D,
  confirm,
  dollars,
  numbers,
  openSheet,
  props,
  scene,
  takeSceneHooks,
  takenBy,
} from "../../../../../tests/helpers/take-scene";
import { timeText } from "../../../money/numbers";
import { nowOf } from "../state";
import { TakeOffer } from "./TakeOffer";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);

takeSceneHooks();

describe("why the press is off", () => {
  async function blockedBy(pattern: RegExp) {
    await openSheet().catch(() => null);
    expect((await screen.findByTestId("take-blocked")).textContent).toMatch(
      pattern,
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  }

  it("the team has not checked in lately", async () => {
    const task = scene();
    chain.answers.activeEnd = [BigInt(numbers.asOf.time - 10)];
    wrap(<TakeOffer {...props(task)} />);
    await blockedBy(/The team has not checked in lately/);
  });

  it("someone else took it while the record still said it was open", async () => {
    const task = scene();
    chainSays(takenBy(STRANGER_EVM));
    wrap(<TakeOffer {...props(task)} />);
    await blockedBy(/was already taken, withdrawn or has ended/);
  });

  it("the notice is still running by the network's own date", async () => {
    const task = scene();
    const row = plannedRowOf(numbers);
    const later = nowOf(numbers.asOf.time) + 3_600;
    chainSays({ noticeEnd: later });
    wrap(<TakeOffer {...props(task)} />);
    await blockedBy(
      new RegExp(
        `This task can be taken from ${timeText(later).replace(".", "\\.")}`,
      ),
    );
    expect(row.noticeEnd).toBeLessThan(later);
  });

  it("the take window is over by the network's clock", async () => {
    const task = scene();
    chain.blockTime = plannedRowOf(numbers).expiresAt + 5;
    wrap(<TakeOffer {...props(task)} />);
    await blockedBy(/The time to take this task is over/);
  });

  it("the limit on money set aside leaves no room, by the book's room and the record's both, and says when room comes back", async () => {
    const need = 100;
    const task = scene({
      patch: (content) => {
        const tasks = content.tasks as Record<string, unknown>;
        (tasks.cap as Record<string, unknown>).roomBps = 0;
        const frees = (tasks.cap as { frees: { at: number; bps: number }[] })
          .frees;
        frees[0] = {
          at: (content.asOf as { time: number }).time + 86_400,
          bps: need,
        };
      },
    });
    chain.answers.takeRoomBps = [0n];
    wrap(<TakeOffer {...props(task)} />);
    await blockedBy(
      /Too much of the project's money has been set aside for tasks recently/,
    );
    expect(screen.getByTestId("take-blocked").textContent).toMatch(
      /Room comes back from /,
    );
  });

  it("is not blocked when only the book's room is short: a take settles a task that ran out first and frees its share", async () => {
    const task = scene();
    chain.answers.takeRoomBps = [0n];
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    expect(screen.queryByTestId("take-blocked")).toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it("another account is in use than the one the task is named for", async () => {
    const task = scene({ account: STRANGER_EVM });
    wrap(<TakeOffer {...props(task, { address: STRANGER_EVM })} />);
    await blockedBy(
      /You are using another account, so you cannot take this task here/,
    );
  });
});

describe("the last look and the one send", () => {
  it("looks again right before the send: a task someone took meanwhile is not taken", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    chainSays(takenBy(STRANGER_EVM));
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /changed while you were looking: it is now taken/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("looks again right before the send: the team stopped checking in meanwhile", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    chain.answers.activeEnd = [BigInt(numbers.asOf.time - 10)];
    fireEvent.click(confirm());
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /The team has not checked in lately/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("a double press sends one call", async () => {
    const task = scene();
    chain.holdReceipts = true;
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("a send that went out but has not landed is looked for, not sent again: a task found taken by you is the step that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const task = scene();
    chain.holdReceipts = true;
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("take-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("take-sheet")).toBeNull());
    // It landed under another hash after all: the network has the task taken by this wallet.
    chainSays(takenBy(WORKER_WALLET));
    fireEvent.click(await screen.findByTestId("take-open"));
    await screen.findByTestId("take-named");
    // "Already taken" is the step having landed: no block, and the press looks for it instead of sending.
    expect(screen.queryByTestId("take-blocked")).toBeNull();
    expect(confirm().textContent).toBe("Look for your step");
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() => expect(screen.queryByTestId("take-sheet")).toBeNull());
    expect(chain.sent).toHaveLength(1);
  }, 20_000);

  it("a task taken by someone else is a block even while a send of ours may be waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const task = scene();
    chain.holdReceipts = true;
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    fireEvent.keyDown(screen.getByTestId("take-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("take-sheet")).toBeNull());
    chainSays(takenBy(STRANGER_EVM));
    fireEvent.click(await screen.findByTestId("take-open"));
    expect((await screen.findByTestId("take-blocked")).textContent).toMatch(
      /was already taken/,
    );
    expect(confirm().disabled).toBe(true);
  }, 20_000);

  it("says what the network set aside, once it landed, from its own numbers", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    chain.onSend = () => chainSays(takenBy(WORKER_WALLET));
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    expect(
      await screen.findByText("Taken. Hand your work in on the task."),
    ).toBeTruthy();
    const taken = takenBy(WORKER_WALLET);
    expect(
      await screen.findByText(
        `Taken. ${dollars(50n * D)} are set aside for you until ${timeText(taken.deadline as number)}. Hand your work in on the task.`,
      ),
    ).toBeTruthy();
  });

  it("says in words a refusal from the network, and keeps the press", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    chain.refuse = "execution reverted: TakesFull()";
    fireEvent.click(confirm());
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(
      /The limit on tasks taken recently has been reached/,
    );
    expect(problem.textContent).not.toMatch(/TakesFull/);
    expect(confirm().disabled).toBe(false);
  });
});
