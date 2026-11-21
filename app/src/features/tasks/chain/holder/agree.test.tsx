// The helper a task names says yes and names the wallet they will be paid at: one press that connects the wallet and writes
// their own `accept` step carrying it. Offered only to that helper, only on a task that pays, only while no wallet is named
// and the task is still theirs to do.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../../../tests/helpers/money-harness";
import {
  FOUNDER_KEY,
  planTask,
  queueOf,
  sceneNumbers,
  WORKER,
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import type { Project } from "../../../project/project-record";
import type { ProjectTask } from "../../task-record";
import type { TaskSlotProps } from "../slot-props";
import { nowOf } from "../state";
import { AgreeButton } from "./AgreeButton";
import { offersAgree } from "./agree-record";

const written: { record: { tags: string[][]; content: string } }[] = [];
let connect: () => Promise<string>;

const sender = vi.hoisted(() => ({ kind: "wallet" as "wallet" | "passkey" }));
vi.mock("../../../money/use-money", () => ({
  useWallet: () => ({ kind: sender.kind }),
  useConnectWallet: () => ({
    isPending: false,
    mutateAsync: () => connect(),
  }),
}));
vi.mock("../../use-tasks", () => ({
  useTaskWrite: () => ({
    isPending: false,
    mutate: (
      input: { record: { tags: string[][]; content: string } },
      options?: { onSuccess?: () => void },
    ) => {
      written.push(input);
      options?.onSuccess?.();
    },
  }),
}));
vi.mock("../../../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;

/** A task that names its helper (the worker), pays 100 dollars, and has no wallet named yet. */
const named = (over: Partial<ProjectTask> = {}): ProjectTask =>
  planTask({ openToAnyone: false, state: "offered", payTo: null, ...over });

function props(task: ProjectTask, me: string | null = WORKER): TaskSlotProps {
  const numbers = sceneNumbers();
  return {
    project,
    task,
    chain: null,
    tasks: queueOf(numbers),
    numbers,
    me,
    address: null,
    team: new Set([FOUNDER_KEY]),
    agents: new Set(),
    operators: new Map(),
    profiles: undefined,
    now: nowOf(numbers.asOf.time),
  };
}

beforeEach(() => {
  sender.kind = "wallet";
  written.length = 0;
  connect = async () => WORKER_WALLET;
});
afterEach(cleanup);

describe("the named helper's yes", () => {
  it("says the task is for them and offers one press", () => {
    wrap(<AgreeButton {...props(named())} />);
    expect(screen.getByTestId("agree-words").textContent).toBe(
      "This task is for you. Say yes and the wallet you connect is where you will be paid. Nothing is paid or moved by this.",
    );
    // The press names the task after its own words, so two cards' presses are told apart.
    expect(
      screen.getByRole("button", {
        name: "Agree and name my wallet: Translate the guide",
      }),
    ).toBeTruthy();
  });

  it("says account, never wallet, to a person who signed in with a passkey", async () => {
    sender.kind = "passkey";
    connect = async () => WORKER_WALLET;
    wrap(<AgreeButton {...props(named())} />);
    expect(screen.getByTestId("agree-words").textContent).toBe(
      "This task is for you. Say yes and your account is where you will be paid. Nothing is paid or moved by this.",
    );
    expect(
      screen.getByRole("button", {
        name: "Agree and name my account: Translate the guide",
      }),
    ).toBeTruthy();
    cleanup();
    connect = async () => {
      throw new Error("not read");
    };
    wrap(<AgreeButton {...props(named())} />);
    fireEvent.click(screen.getByTestId("agree-press"));
    expect(
      await screen.findByText(
        "Your account could not be read, so nothing was saved. Try again.",
      ),
    ).toBeTruthy();
    expect(written).toHaveLength(0);
  });

  it("connects the wallet and writes their own accept step carrying it, and nothing else", async () => {
    const task = named();
    wrap(<AgreeButton {...props(task)} />);
    fireEvent.click(screen.getByTestId("agree-press"));
    await waitFor(() => expect(written).toHaveLength(1));
    const tags = written[0]?.record.tags ?? [];
    const tag = (name: string) => tags.find((t) => t[0] === name)?.[1];
    expect(tag("task-part")).toBe("accept");
    expect(tag("task-pay-to")).toBe(WORKER_WALLET);
    expect(tag("task")).toBe(task.id);
    expect(tag("a")).toBe(project.coordinate);
    // Nothing about money is written: the step only says yes and where.
    expect(
      tags.filter(
        (t) =>
          t[0].startsWith("task-") &&
          t[0] !== "task-part" &&
          t[0] !== "task-pay-to",
      ),
    ).toEqual([]);
    expect(
      await screen.findByText("Saved. The team can plan your pay now."),
    ).toBeTruthy();
  });

  it("a wallet that cannot be connected is said in words and nothing is written", async () => {
    connect = async () => {
      throw new Error("The wallet was closed.");
    };
    wrap(<AgreeButton {...props(named())} />);
    fireEvent.click(screen.getByTestId("agree-press"));
    expect(
      await screen.findByText(
        "The wallet could not be connected, so nothing was saved. Open your wallet and try again.",
      ),
    ).toBeTruthy();
    expect(written).toEqual([]);
  });

  it("is offered only to the helper the task names, on a task that pays, with no wallet named, while it is still theirs", () => {
    const yes = named();
    expect(offersAgree(yes, WORKER)).toBe(true);
    // Working (the helper handed in nothing yet, or said yes without a wallet before) is still theirs.
    expect(offersAgree(named({ state: "working" }), WORKER)).toBe(true);
    // Not the helper, not signed in.
    expect(offersAgree(yes, FOUNDER_KEY)).toBe(false);
    expect(offersAgree(yes, null)).toBe(false);
    // Nobody signed in is never "the helper", even for a record that names no one.
    expect(offersAgree(named({ worker: null }), null)).toBe(false);
    // A task open to anyone has its taker's own press (the take names the wallet).
    expect(offersAgree(named({ openToAnyone: true }), WORKER)).toBe(false);
    // A task that pays nothing has no wallet to name; one that has a wallet needs no yes.
    expect(offersAgree(named({ usd: null }), WORKER)).toBe(false);
    expect(offersAgree(named({ payTo: WORKER_WALLET }), WORKER)).toBe(false);
    // Handed in, accepted, given up or stopped: it is no longer theirs to agree to.
    for (const state of [
      "submitted",
      "accepted",
      "given-up",
      "cancelled",
    ] as const)
      expect(offersAgree(named({ state }), WORKER)).toBe(false);
  });

  it("draws nothing for anyone else", () => {
    wrap(<AgreeButton {...props(named(), FOUNDER_KEY)} />);
    expect(screen.queryByTestId("agree")).toBeNull();
  });
});
