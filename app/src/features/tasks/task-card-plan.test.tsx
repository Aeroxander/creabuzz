// A task card where the task is planned on the network: the network's headline first and the team's step under it, one door
// (the step 1 pay presses are not drawn), every money line from the network's row (a part payment never reads as paid in full),
// the plan ended without a payment (the step 1 card is back), and the line that says a plan cannot be taken unless the team
// checks in. Without a plan the card is the step 1 card.
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import {
  FOUNDER_KEY,
  planTask,
  pointRow,
  queueOf,
  sceneNumbers,
  WORKER,
} from "../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import type { ChainTask } from "./chain/types";
import { TaskCard } from "./TaskCard";
import type { ProjectTask } from "./task-record";

vi.mock("../money/use-money", () => ({
  useMoneySend: () => ({ isPending: false, send: () => {} }),
  useConnectWallet: () => ({ isPending: false, mutateAsync: async () => null }),
  useWallet: () => ({
    readCall: async () => "0x",
    blockNumber: async () => 1,
    getLogs: async () => [],
  }),
  useWalletAddress: () => ({ data: null }),
  useWalletOnChain: () => true,
}));
vi.mock("./use-tasks", () => ({
  freshTask: async () => null,
  useTaskWrite: () => ({ isPending: false, mutate: () => {} }),
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/week">{children}</a>
  ),
}));

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;
const PIECE = "1".repeat(64);
const TX = `0x${"ab".repeat(32)}`;

function rowIn(numbers: ProjectNumbers, state: string): ChainTask {
  const row = queueOf(numbers).list.find((r) => r.state === state);
  if (!row) throw new Error(`the example has no ${state} row`);
  return row;
}

/** A project whose row of this state is the plan of the team's task record, and the record that goes with it. */
function sceneFor(
  state: string,
  patch?: (content: Record<string, unknown>) => void,
  task: Partial<ProjectTask> = {},
) {
  const probe = sceneNumbers();
  const serial = Number(rowIn(probe, state).serial);
  const numbers = sceneNumbers((content) => {
    pointRow(content, serial);
    patch?.(content);
  });
  const row = rowIn(numbers, state);
  const record = planTask({
    usd: Number(row.maxDollars / 1_000_000n),
    payTo: row.takenBy ?? row.payee,
    state: "submitted",
    handIn: { id: PIECE, at: 1, note: "done" },
    ...task,
  });
  return { numbers, row, record };
}

function show(
  numbers: ProjectNumbers | null,
  task: ProjectTask,
  options: { me?: string; address?: string | null } = {},
) {
  return wrap(
    <TaskCard
      address={
        options.address === undefined
          ? (numbers?.runner.address ?? null)
          : options.address
      }
      agents={new Set()}
      me={options.me ?? FOUNDER_KEY}
      numbers={numbers}
      operators={new Map()}
      profiles={undefined}
      project={project}
      task={task}
      team={new Set([FOUNDER_KEY])}
    />,
  );
}

/** Dollars as a person reads them: whole cents, the rest dropped (an amount is never read as more than it is). */
const cents = (raw: bigint) => (Number(raw / 10_000n) / 100).toFixed(2);

afterEach(cleanup);

describe("a task with a live plan on the network", () => {
  it("shows the network's headline first and the team's own step under it, and they never swap", () => {
    const { numbers, record } = sceneFor("taken");
    show(numbers, record);
    const headline = screen.getByTestId("task-chain-state");
    expect(headline.getAttribute("data-state")).toBe("working");
    expect(headline.textContent).toMatch(/^Taken, due /);
    const step = screen.getByTestId("task-state");
    expect(step.textContent).toBe("Work handed in");
    expect(
      headline.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a team record that says Accepted while the network says taken still reads taken", () => {
    const { numbers, record } = sceneFor("taken", undefined, {
      state: "accepted",
    });
    show(numbers, record);
    expect(screen.getByTestId("task-chain-state").textContent).toMatch(
      /^Taken, due /,
    );
    expect(screen.getByTestId("task-state").textContent).toBe("Accepted");
  });

  it("draws no step 1 pay press: not Accept and pay, not Pay from the box, even for the runner", () => {
    const { numbers, record } = sceneFor("taken");
    show(numbers, record);
    // Nor the line that says what the record pays on accept: that is the team's word, not the network's.
    expect(screen.queryByTestId("task-pays")).toBeNull();
    expect(screen.queryByTestId("task-accept")).toBeNull();
    expect(screen.queryByTestId("task-pay-section")).toBeNull();
    cleanup();
    // The same for an accepted task whose pay was owed (step 1 offered Pay from the box).
    const owed = sceneFor("taken", undefined, {
      state: "accepted",
      acceptedBy: FOUNDER_KEY,
    });
    show(owed.numbers, owed.record);
    expect(screen.queryByTestId("task-pay-section")).toBeNull();
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });

  it("every money line is the network's: what is set aside, never what the team's record says it pays", () => {
    const { numbers, row, record } = sceneFor("taken", undefined, {
      state: "accepted",
    });
    show(numbers, record);
    expect(screen.queryByTestId("task-pays")).toBeNull();
    expect(screen.queryByTestId("task-pay-owed")).toBeNull();
    expect(screen.queryByTestId("task-paid")).toBeNull();
    const detail = screen.getByTestId("task-chain-detail").textContent ?? "";
    expect(detail).toMatch(/are set aside for it\.$/);
    // The figure is the row's: 57.48 dollars here, not the 400 the record says.
    expect(detail).toContain(cents(row.setAside));
    expect(screen.getByTestId("task-card").textContent).not.toMatch(
      /400 dollars/,
    );
  });

  it("a part payment never reads as paid in full", () => {
    const { numbers, row, record } = sceneFor("paid", undefined, {
      state: "accepted",
      paidTx: TX,
      acceptedBy: FOUNDER_KEY,
    });
    expect(row.pay).toBeLessThan(row.setAside);
    show(numbers, record);
    expect(screen.getByTestId("task-chain-state").textContent).toBe(
      `Paid ${cents(row.pay)} dollars.`,
    );
    expect(screen.getByTestId("task-chain-detail").textContent).toMatch(
      /of the .* dollars set aside; the rest went back\.$/,
    );
    // The record's own "Paid 400 dollars." is not drawn, and there is nothing to pay. A finished task is not told that its
    // paid record fails to tie.
    expect(screen.queryByTestId("task-paid")).toBeNull();
    expect(screen.queryByTestId("task-chain-tie")).toBeNull();
    expect(screen.queryByTestId("task-pay-section")).toBeNull();
  });

  it("a paid record whose network row left the list never reads as paid in full: the price, not the payment", () => {
    // A task paid in part (4 of 6 dollars) whose row aged out of the record's list: the record names the payment, the queue has
    // no row for it, and the posted price is all the card has. It says paid, and says that is the price.
    const numbers = sceneNumbers();
    const record = planTask({
      usd: 6,
      state: "accepted",
      acceptedBy: FOUNDER_KEY,
      acceptedAt: 1,
      handIn: { id: PIECE, at: 1, note: "done" },
      paidTx: TX,
    });
    expect(queueOf(numbers).list.some((r) => r.what === `0x${record.id}`)).toBe(
      false,
    );
    show(numbers, record);
    expect(screen.getByTestId("task-paid").textContent).toBe(
      "Paid. The price was 6 dollars.",
    );
  });

  it("a plan that is not for this task as the team wrote it shows the network's numbers and says why", () => {
    const { numbers, record } = sceneFor("taken", undefined, {
      payTo: "0x00000000000000000000000000000000000000ee",
    });
    show(numbers, record);
    expect(screen.getByTestId("task-chain-state")).toBeTruthy();
    expect(screen.getByTestId("task-chain-tie").textContent).toMatch(
      /not for this task as it is written here .*wallet/,
    );
  });

  it("says plainly that a plan cannot be taken unless the team checks in, to anyone who reads the card", () => {
    const { numbers, record } = sceneFor("announced", (content) => {
      (content.clock as { activeUntil: number }).activeUntil =
        (content.asOf as { time: number }).time + 10;
    });
    show(numbers, record, { me: WORKER, address: null });
    expect(screen.getByTestId("task-not-takeable").textContent).toMatch(
      /^This task cannot be taken unless the team sends its weekly update \(its check-in\) before /,
    );
  });

  it("does not say that when the check-in covers the day it can first be taken", () => {
    const { numbers, record } = sceneFor("announced");
    show(numbers, record, { me: WORKER, address: null });
    expect(screen.queryByTestId("task-not-takeable")).toBeNull();
  });

  it("marks the words as maybe out of date when the record is over a day old, and still shows the plan", () => {
    const { numbers, record } = sceneFor("taken", (content) => {
      content.builtAt = (content.builtAt as number) - 2 * 86_400;
    });
    show(numbers, record);
    expect(screen.getByTestId("task-chain-state")).toBeTruthy();
    expect(screen.getByTestId("task-chain-age").textContent).toMatch(
      /This may be out of date: the server has not refreshed this project since\.$/,
    );
  });

  it("marks the network's words as of the record's time when the record is old", () => {
    const { numbers, record } = sceneFor("taken", (content) => {
      content.builtAt = (content.builtAt as number) - 5_000;
    });
    show(numbers, record);
    expect(screen.getByTestId("task-chain-age").textContent).toMatch(/^as of /);
  });

  it("is a card with one name: the article is labelled by the task's words", () => {
    const { numbers, record } = sceneFor("taken");
    show(numbers, record);
    const card = screen.getByTestId("task-card");
    const labelled = card.getAttribute("aria-labelledby");
    expect(labelled).toBeTruthy();
    expect(document.getElementById(labelled ?? "")?.textContent).toBe(
      record.what,
    );
  });
});

describe("a task with no live plan", () => {
  it("is the step 1 card: Pays on accept, Accept and pay, and no network headline", () => {
    const { numbers, record } = sceneFor("cancelled");
    show(numbers, record);
    expect(screen.queryByTestId("task-chain-state")).toBeNull();
    expect(screen.getByTestId("task-pays").textContent).toMatch(
      /^Pays .* on accept$/,
    );
    expect(screen.getByTestId("task-accept")).toBeTruthy();
    // What happened to the plan is one muted line.
    expect(screen.getByTestId("task-plan-ended").textContent).toMatch(
      /^The plan for “Translate the guide” was withdrawn\.$/,
    );
  });

  it("with no row for it at all reads exactly as before", () => {
    const numbers = sceneNumbers();
    show(
      numbers,
      planTask({
        id: "9".repeat(64),
        state: "submitted",
        handIn: { id: PIECE, at: 1, note: "done" },
      }),
    );
    expect(screen.queryByTestId("task-chain-state")).toBeNull();
    expect(screen.queryByTestId("task-plan-ended")).toBeNull();
    expect(screen.getByTestId("task-pays")).toBeTruthy();
  });

  it("with no queue in the record is the step 1 card", () => {
    const { record } = sceneFor("taken");
    const bare = {
      chainId: 31337,
      playMoney: true,
      windDown: null,
      runner: {
        address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        isPair: false,
        signers: null,
      },
      contracts: { treasury: "0x20b6000000000000000000000000000000000906" },
      allowance: { box: 1_000_000_000n, ratePpm: 1000 },
      money: { pot: 7_000_000_000n },
    } as unknown as ProjectNumbers;
    show(bare, record);
    expect(screen.queryByTestId("task-chain-state")).toBeNull();
    expect(screen.getByTestId("task-pays")).toBeTruthy();
  });
});

describe("a task that names its helper", () => {
  it("offers the named helper, on the card, the step that names their wallet; nobody else", () => {
    const numbers = sceneNumbers();
    const named = planTask({
      openToAnyone: false,
      state: "offered",
      payTo: null,
    });
    show(numbers, named, { me: WORKER, address: null });
    expect(screen.getByTestId("agree-words").textContent).toMatch(
      /^This task is for you\./,
    );
    cleanup();
    show(numbers, named, { me: FOUNDER_KEY });
    expect(screen.queryByTestId("agree")).toBeNull();
  });
});
