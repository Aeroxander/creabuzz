import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { AcceptAndPay } from "./AcceptAndPay";
import { forgetPaid, rememberPaid } from "./paid-journal";
import type { ProjectTask } from "./task-record";
import { TaskCard } from "./TaskCard";

const FOUNDER = "f".repeat(64);
const MATE = "e".repeat(64);
const AGENT = "c".repeat(64);
const TAKER = "a".repeat(64);
const COORD = `37001:${FOUNDER}:orbit`;
const PAYEE = "0x00000000000000000000000000000000000000cd";
const WALLET = "0x00000000000000000000000000000000000000ee";
const TX = `0x${"ab".repeat(32)}`;
const PIECE = "1".repeat(64);
const NEWER = "2".repeat(64);

const sent: unknown[] = [];
const written: { record: { tags: string[][] } }[] = [];
let fresh: ProjectTask | null;
/** What the chain answers for the allowance box (null: the node does not answer). */
let chainBox: bigint | null = null;

vi.mock("../money/use-money", () => ({
  useMoneySend: () => ({
    isPending: false,
    send: (input: unknown, options?: { onSuccess?: (r: unknown) => void }) => {
      sent.push(input);
      options?.onSuccess?.({ txHash: TX });
    },
  }),
  useConnectWallet: () => ({ isPending: false, mutateAsync: async () => null }),
  useWallet: () => ({
    readCall: async () => {
      if (chainBox === null) throw new Error("The node did not answer.");
      return `0x${chainBox.toString(16).padStart(64, "0")}`;
    },
  }),
}));
vi.mock("./use-tasks", () => ({
  freshTask: async () => fresh,
  useTaskWrite: () => ({
    isPending: false,
    mutate: (
      input: { record: { tags: string[][] } },
      options?: { onSuccess?: () => void },
    ) => {
      written.push(input);
      options?.onSuccess?.();
    },
  }),
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));

const project = { coordinate: COORD, author: FOUNDER } as unknown as Project;
const TREASURY = "0x20b6000000000000000000000000000000000906";
/** The parts of a version 2 record a payment reads: the runner, the contracts, the box and what feeds it. */
const numbers = {
  chainId: 31337,
  runner: { address: WALLET, isPair: false, signers: null },
  contracts: { treasury: TREASURY },
  allowance: { box: 100_000_000n, ratePpm: 1000 },
  money: { pot: 7_322_810_944n },
} as unknown as ProjectNumbers;
const withNumbers = (change: object) =>
  ({ ...numbers, ...change }) as unknown as ProjectNumbers;

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "9".repeat(64),
    author: FOUNDER,
    at: 1_800_000_000,
    what: "Translate the guide",
    usd: 40,
    openToAnyone: true,
    worker: TAKER,
    payTo: PAYEE,
    state: "submitted",
    handIn: { id: PIECE, at: 1_800_000_100, note: "done" },
    acceptedBy: null,
    paidTx: null,
    ...over,
  };
}

const press = () => fireEvent.click(screen.getByTestId("task-accept"));
const tagOf = (name: string) =>
  written[0]?.record.tags.find((t) => t[0] === name)?.[1];

beforeEach(() => {
  sent.length = 0;
  written.length = 0;
  fresh = task();
  chainBox = null;
  forgetPaid(task().id);
});
afterEach(cleanup);

describe("accept and pay", () => {
  it("pays once and writes the record after, when the task is as the page showed it", async () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={numbers}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-accept").textContent).toBe(
      "Accept and pay 40 dollars",
    );
    press();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(tagOf("task-paid")).toBe(TX);
    expect(tagOf("task-evidence")).toBe(PIECE);
  });

  it("pays by a draw from the allowance box, to the taker's wallet", async () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={numbers}
        project={project}
        task={task()}
      />,
    );
    press();
    await waitFor(() => expect(sent).toHaveLength(1));
    const input = sent[0] as {
      chainId: number;
      build: () => { to: string; data: string }[];
    };
    const [call] = input.build();
    expect(call?.to).toBe(TREASURY);
    const draw = decodeCall(TREASURY_ABI, call?.data ?? "");
    expect(draw?.name).toBe("draw");
    expect(draw?.args).toEqual([PAYEE, 40_000_000n]);
  });

  it("when the box holds less than the work pays, says how much it holds and that more comes each day, and pays nothing", async () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({
          allowance: { box: 39_999_999n, ratePpm: 1000 },
        })}
        project={project}
        task={task()}
      />,
    );
    const words = screen.getByTestId("task-accept-problem").textContent ?? "";
    expect(words).toContain("The allowance box holds 39.99 dollars now");
    expect(words).toMatch(
      /About 7,322.81 dollars more goes into it each day|About 7.32 dollars more goes into it each day/,
    );
    // Not paying from here is still a way forward, as a second, plainly worded choice: nothing is sent.
    expect(screen.getByTestId("task-accept").textContent).toBe(
      "Accept without paying 40 dollars",
    );
    press();
    expect(screen.getByTestId("task-pay-later").textContent).toMatch(
      /Draw from the box/,
    );
    press();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(tagOf("task-paid")).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("offers the press when the record's box is short but the chain already holds enough", async () => {
    // The record is hours old; the chain's own box is what counts.
    chainBox = 45_000_000n;
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({
          allowance: { box: 10_000_000n, ratePpm: 1000 },
        })}
        project={project}
        task={task()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("task-accept").textContent).toBe(
        "Accept and pay 40 dollars",
      ),
    );
    expect(screen.queryByTestId("task-accept-problem")).toBeNull();
    press();
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it("stops before sending when the chain's box, read again at the press, is short", async () => {
    chainBox = 45_000_000n;
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({
          allowance: { box: 10_000_000n, ratePpm: 1000 },
        })}
        project={project}
        task={task()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("task-accept").textContent).toBe(
        "Accept and pay 40 dollars",
      ),
    );
    // Someone drew from the box after the page was drawn.
    chainBox = 20_000_000n;
    press();
    expect(
      (await screen.findByTestId("task-accept-problem")).textContent,
    ).toMatch(/box holds 20 dollars now/);
    expect(sent).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("with the box exactly as full as the pay, offers the press", () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({
          allowance: { box: 40_000_000n, ratePpm: 1000 },
        })}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-accept")).toBeTruthy();
  });

  it("says plainly that a payment from a project run by two people needs both signers, and still lets the work be accepted without paying here", async () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({
          runner: {
            address: "0x00000000000000000000000000000000000000ff",
            isPair: true,
            signers: [WALLET, PAYEE],
          },
        })}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-accept-problem").textContent).toMatch(
      /needs both of you to sign/,
    );
    expect(screen.getByTestId("task-accept").textContent).toBe(
      "Accept without paying 40 dollars",
    );
    press();
    expect(screen.getByTestId("task-pay-later").textContent).toMatch(
      /signed by both of you/,
    );
    expect(written).toHaveLength(0);
    press();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(tagOf("task-paid")).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("says the dollars are play money next to a press that pays", () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({ playMoney: true })}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-play-money").textContent).toMatch(
      /play money/,
    );
  });

  it("says it even when the record says the dollars are not play money", () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={withNumbers({ playMoney: false })}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-play-money").textContent).toMatch(
      /play money/,
    );
  });

  it("will not pay from a wallet that does not run the project", () => {
    wrap(
      <AcceptAndPay
        address={PAYEE}
        numbers={numbers}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-accept-problem").textContent).toMatch(
      /Only the wallet that runs this project/,
    );
  });

  it("looks at the task again before any money moves, and stops when it has changed", async () => {
    // Newer work was handed in since the page last looked: what the person is about to pay for is not what they saw.
    fresh = task({ handIn: { id: NEWER, at: 1_800_000_200, note: "again" } });
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={numbers}
        project={project}
        task={task()}
      />,
    );
    press();
    await screen.findByTestId("task-accept-problem");
    expect(screen.getByTestId("task-accept-problem").textContent).toMatch(
      /changed while you were looking, so nothing was paid/,
    );
    expect(sent).toHaveLength(0);
    expect(written).toHaveLength(0);
    cleanup();
    // The same when it was given up or cancelled, or the taker named another wallet.
    for (const change of [
      { state: "given-up" },
      { state: "cancelled" },
      { payTo: "0x00000000000000000000000000000000000000dd" },
      { worker: MATE },
    ] as const) {
      fresh = task(change);
      wrap(
        <AcceptAndPay
          address={WALLET}
          numbers={numbers}
          project={project}
          task={task()}
        />,
      );
      press();
      await screen.findByTestId("task-accept-problem");
      cleanup();
    }
    fresh = null;
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={numbers}
        project={project}
        task={task()}
      />,
    );
    press();
    await screen.findByTestId("task-accept-problem");
    expect(sent).toHaveLength(0);
  });

  it("closes a paying task whose taker named no wallet only as a second, plainly worded choice", async () => {
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={numbers}
        project={project}
        task={task({ payTo: null })}
      />,
    );
    const button = screen.getByTestId("task-accept");
    expect(button.textContent).toBe("Accept without paying 40 dollars");
    expect(screen.getByTestId("task-no-payee").textContent).toMatch(
      /nothing is paid and this app has no way to pay it later/,
    );
    press();
    // The first press only asks again: nothing is written, nothing is sent.
    expect(written).toHaveLength(0);
    expect(screen.getByTestId("task-accept").textContent).toBe(
      "Yes, accept it without paying",
    );
    press();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(tagOf("task-paid")).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("saves the record for the piece that was paid for, not for newer work handed in since", async () => {
    rememberPaid({
      task: task().id,
      handIn: PIECE,
      txHash: TX,
      at: 1_800_000_150,
    });
    const newer = task({ handIn: { id: NEWER, at: 1_800_000_200, note: "x" } });
    wrap(
      <AcceptAndPay
        address={WALLET}
        numbers={numbers}
        project={project}
        task={newer}
      />,
    );
    expect(screen.getByTestId("task-accept").textContent).toBe(
      "Save that it was paid",
    );
    press();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(tagOf("task-evidence")).toBe(PIECE);
    expect(tagOf("task-paid")).toBe(TX);
    expect(sent).toHaveLength(0);
  });

  it("with money off only accepts the work", async () => {
    wrap(
      <AcceptAndPay
        address={null}
        numbers={null}
        project={project}
        task={task()}
      />,
    );
    expect(screen.getByTestId("task-accept").textContent).toBe(
      "Accept the work",
    );
    press();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(0);
  });
});

describe("a task card where accepting would be checking one's own work", () => {
  it("offers a teammate who runs the worker agent no press, and says why", () => {
    wrap(
      <TaskCard
        address={null}
        agents={new Set([AGENT])}
        me={MATE}
        numbers={numbers}
        operators={new Map([[AGENT, MATE]])}
        profiles={undefined}
        project={
          {
            coordinate: COORD,
            author: FOUNDER,
            team: [{ pubkey: MATE }],
          } as unknown as Project
        }
        task={task({ worker: AGENT })}
        team={new Set([FOUNDER, MATE])}
      />,
    );
    expect(screen.queryByTestId("task-accept")).toBeNull();
    expect(screen.getByTestId("task-own-work").textContent).toMatch(
      /Someone else on the team has to accept it/,
    );
  });

  it("offers the press to someone else on the team", () => {
    wrap(
      <TaskCard
        address={WALLET}
        agents={new Set([AGENT])}
        me={FOUNDER}
        numbers={numbers}
        operators={new Map([[AGENT, MATE]])}
        profiles={undefined}
        project={
          {
            coordinate: COORD,
            author: FOUNDER,
            team: [{ pubkey: MATE }],
          } as unknown as Project
        }
        task={task({ worker: AGENT })}
        team={new Set([FOUNDER, MATE])}
      />,
    );
    expect(screen.getByTestId("task-accept")).toBeTruthy();
    expect(screen.queryByTestId("task-own-work")).toBeNull();
  });
});
