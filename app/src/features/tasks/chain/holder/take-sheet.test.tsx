// Taking a task the network named you for: who is offered the press and what the sheet says and sends. Every figure is read
// from the parsed example (see `tests/helpers/take-scene.ts`).
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { wrap } from "../../../../../tests/helpers/money-harness";
import { taskRow } from "../../../../../tests/helpers/numbers-v2-fixture";
import {
  STRANGER_EVM,
  FOUNDER_EVM,
} from "../../../../../tests/helpers/pot-harness";
import {
  PLANNED_SERIAL,
  plannedRowOf,
  queueOf,
  settled,
  WORKER_WALLET,
  FOUNDER_KEY,
} from "../../../../../tests/helpers/plan-scene";
import {
  chain,
  D,
  confirm,
  dollars,
  numbers,
  openSheet,
  props,
  scene,
  takeSceneHooks,
} from "../../../../../tests/helpers/take-scene";
import { timeText, type ProjectNumbers } from "../../../money/numbers";
import { durationWords } from "../duration";
import { percentOfBps } from "../words";
import { nowOf } from "../state";
import { PlanOnlyCard } from "../team/PlanOnlyCard";
import { TakeOffer } from "./TakeOffer";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);

takeSceneHooks();

describe("who is offered the press", () => {
  it("is the wallet the plan names, once it can be taken, and the press is named for what it does", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    const opener = await screen.findByTestId("take-open");
    expect(opener.textContent).toBe("Set the money aside");
  });

  it("is not a stranger, who reads the plan and has no press", async () => {
    const task = scene({ account: STRANGER_EVM });
    // Positive control: the person named for it is offered the press with the same record.
    wrap(<TakeOffer {...props(task)} />);
    await screen.findByTestId("take-open");
    cleanup();
    wrap(<TakeOffer {...props(task, { me: null, address: STRANGER_EVM })} />);
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
    expect(screen.queryByTestId("take-wait")).toBeNull();
  });

  it("is never the person who runs the project, nor one of a Pair's two signers, even when a plan names them", async () => {
    const task = scene({
      account: FOUNDER_EVM,
      patch: (content) => {
        taskRow(
          content.tasks as Record<string, unknown>,
          PLANNED_SERIAL,
        ).payee = FOUNDER_EVM;
      },
    });
    const asRunner = { ...task, payTo: FOUNDER_EVM };
    wrap(
      <TakeOffer
        {...props(asRunner, { me: FOUNDER_KEY, address: FOUNDER_EVM })}
      />,
    );
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
    cleanup();
    const second = "0x00000000000000000000000000000000000000dd";
    const pair = scene({
      account: second,
      patch: (content) => {
        taskRow(
          content.tasks as Record<string, unknown>,
          PLANNED_SERIAL,
        ).payee = second;
        content.runner = {
          address: "0x00000000000000000000000000000000000000ff",
          isPair: true,
          signers: [FOUNDER_EVM, second],
        };
      },
    });
    wrap(
      <TakeOffer
        {...props(
          { ...pair, payTo: second },
          { me: FOUNDER_KEY, address: second },
        )}
      />,
    );
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
  });

  it('reads "you can take it from" a date while the notice runs, with no press', async () => {
    const task = scene({ notice: "running" });
    wrap(<TakeOffer {...props(task)} />);
    const row = plannedRowOf(numbers);
    expect((await screen.findByTestId("take-wait")).textContent).toBe(
      `You can take it from ${timeText(row.noticeEnd)}.`,
    );
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
  });

  it("says a plan that names nobody is open to anyone, and offers no press to anyone", async () => {
    const task = scene({
      patch: (content) => {
        taskRow(
          content.tasks as Record<string, unknown>,
          PLANNED_SERIAL,
        ).payee = null;
      },
    });
    wrap(<TakeOffer {...props(task)} />);
    expect((await screen.findByTestId("take-open-to-anyone")).textContent).toBe(
      "Open to anyone. The team chose not to name who is paid.",
    );
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
  });

  it("offers nothing on a task that was taken, ended, lapsed, or on a wound-down project", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await screen.findByTestId("take-open");
    cleanup();
    const row = plannedRowOf(numbers);
    // Past the take window the plan has lapsed by the dates, whatever the book still says.
    wrap(<TakeOffer {...props(task, { now: row.expiresAt + 1 })} />);
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
    cleanup();
    wrap(
      <TakeOffer
        {...props(task, {
          numbers: {
            ...numbers,
            windDown: { at: numbers.asOf.time },
          } as ProjectNumbers,
        })}
      />,
    );
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
  });

  it("is offered on a plan that no task record here names, to the wallet it names and to no one else", async () => {
    scene();
    const row = plannedRowOf(numbers);
    const card = (address: string) => (
      <PlanOnlyCard
        address={address}
        ageNote={null}
        now={nowOf(numbers.asOf.time)}
        numbers={numbers}
        row={row}
        windDownAt={null}
      />
    );
    wrap(card(WORKER_WALLET));
    expect((await screen.findByTestId("take-open")).textContent).toBe(
      "Set the money aside",
    );
    cleanup();
    wrap(card(STRANGER_EVM));
    await settled();
    expect(screen.queryByTestId("take-open")).toBeNull();
  });

  it("goes to the wrong-network gate and offers no press when the wallet is on another network", async () => {
    const task = scene();
    chain.chain = "0x1";
    wrap(<TakeOffer {...props(task)} />);
    expect(await screen.findByTestId("pot-wrong-network")).toBeTruthy();
    expect(screen.queryByTestId("take-open")).toBeNull();
  });
});

describe("the Take sheet", () => {
  it("says who is named, what is set aside now and what happens after, with the guard checked", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    const row = plannedRowOf(numbers);
    expect(screen.getByTestId("take-named").textContent).toBe(
      `You are named for this task: ${dollars(row.maxDollars)} at most.`,
    );
    const share = (numbers.money.pot * BigInt(row.shareBps)) / 10_000n;
    const now = share < row.maxDollars ? share : row.maxDollars;
    expect(screen.getByTestId("take-amount").textContent).toBe(
      `Taking it sets money aside for you now: the smaller of ${dollars(row.maxDollars)} and ${percentOfBps(row.shareBps)} of the project's money, about ${dollars(now)} today.`,
    );
    expect(screen.getByTestId("take-due").textContent).toBe(
      `If the team accepts your work, you are paid what they choose, up to what is set aside, by ${durationWords(queueOf(numbers).limits.dueSecs)} after you take it. If they do not, the money goes back.`,
    );
    const guard = screen.getByRole("checkbox", {
      name: `Take it only if the whole ${dollars(row.maxDollars)} is set aside`,
    }) as HTMLInputElement;
    expect(guard.checked).toBe(true);
    expect(screen.getByTestId("take-guard-hint").textContent).toBe(
      "Nothing is taken if less would be set aside.",
    );
    expect(screen.getByTestId("sheet-play-money")).toBeTruthy();
    expect(confirm().textContent).toBe("Set the money aside");
    expect(confirm().disabled).toBe(false);
  });

  it("sends the whole most as the least accepted when the guard is checked, and one dollar when it is not", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    const row = plannedRowOf(numbers);
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    let call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.name).toBe("takeTask");
    expect(call?.args).toEqual([row.serial, row.maxDollars]);
    expect(chain.sent[0]?.to).toBe(numbers.contracts.treasury);
    expect(chain.sent[0]?.from).toBe(WORKER_WALLET);
    cleanup();
    const again = scene();
    wrap(<TakeOffer {...props(again)} />);
    await openSheet();
    fireEvent.click(screen.getByTestId("take-guard"));
    expect(screen.getByTestId("take-guard-hint").textContent).toBe(
      `Unchecked, you accept as little as ${dollars(queueOf(numbers).limits.minTask)}.`,
    );
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.args).toEqual([row.serial, queueOf(numbers).limits.minTask]);
  });

  it("warns, with the guard checked, that the project's money has fallen so the whole most is not covered, and not when unchecked", async () => {
    const task = scene({
      patch: (content) => {
        taskRow(
          content.tasks as Record<string, unknown>,
          PLANNED_SERIAL,
        ).maxDollars = String(400n * D);
      },
    });
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    const row = plannedRowOf(numbers);
    const share = (numbers.money.pot * BigInt(row.shareBps)) / 10_000n;
    expect(share).toBeLessThan(row.maxDollars);
    expect(screen.getByTestId("take-short").textContent).toBe(
      `Right now about ${dollars(share)} would be set aside, less than the whole ${dollars(row.maxDollars)}. With the box checked, nothing is taken.`,
    );
    fireEvent.click(screen.getByTestId("take-guard"));
    expect(screen.queryByTestId("take-short")).toBeNull();
  });

  it("marks what it says with the record's age when the record is old", async () => {
    const task = scene({
      patch: (content) => {
        (content as { builtAt: number }).builtAt -= 3 * 3_600;
      },
    });
    wrap(<TakeOffer {...props(task)} />);
    await openSheet();
    expect((await screen.findByTestId("take-age")).textContent).toBe(
      `as of ${timeText(numbers.asOf.time)}`,
    );
  });

  it("is a dialog named for the task, one press only, a labelled box, and Escape gives focus back", async () => {
    const task = scene();
    wrap(<TakeOffer {...props(task)} />);
    const opener = await screen.findByTestId("take-open");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("take-named");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /^Set the money aside for/ }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Set the money aside" }),
    ).toHaveLength(1);
    expect(screen.getByRole("checkbox").getAttribute("aria-describedby")).toBe(
      "take-guard-hint",
    );
    fireEvent.keyDown(screen.getByTestId("take-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("take-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("take-open"));
  });

  it("says it could not read, and offers to try again, when the network cannot be asked", async () => {
    const task = scene();
    delete chain.answers.taskOf;
    wrap(<TakeOffer {...props(task)} />);
    fireEvent.click(await screen.findByTestId("take-open"));
    expect((await screen.findByTestId("take-read-failed")).textContent).toMatch(
      /could not be read from the network, so nothing can be sent now\. Nothing was set aside\./,
    );
    expect(confirm().disabled).toBe(true);
    expect(chain.sent).toEqual([]);
  });
});
