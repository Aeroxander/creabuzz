import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { addressTopic, topicOf } from "@creaton/core/launchpad/work.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { forgetPaid } from "./paid-journal";
import type { ProjectTask } from "./task-record";
import { TaskCard } from "./TaskCard";

const FOUNDER = "f".repeat(64);
const MATE = "e".repeat(64);
const TAKER = "a".repeat(64);
const COORD = `37001:${FOUNDER}:orbit`;
const PAYEE = "0x00000000000000000000000000000000000000cd";
const WALLET = "0x00000000000000000000000000000000000000ee";
const TX = `0x${"ab".repeat(32)}`;
const FOUND_TX = `0x${"cd".repeat(32)}`;
const PIECE = "1".repeat(64);
const OTHER_TASK = "8".repeat(64);
const TREASURY = "0x20b6000000000000000000000000000000000906";
const DRAWN = topicOf("AllowanceDrawn(address,address,uint256,uint256)");

const sent: { chainId: number; build: () => { to: string; data: string }[] }[] =
  [];
const written: { record: { tags: string[][]; content: string } }[] = [];
let fresh: ProjectTask | null;
let chainBox: bigint | null = null;
let logs: unknown[] = [];
let recordFails = false;
let logsFail = false;
let head = 100;
let startTime: number | null = null;
/** When set, the time of a block by its number (otherwise every block has `startTime`). */
let timeAt: ((block: number) => number) | null = null;
let logCalls = 0;

vi.mock("../money/use-money", () => ({
  useMoneySend: () => ({
    isPending: false,
    send: (
      input: (typeof sent)[number],
      options?: { onSuccess?: (r: unknown) => void },
    ) => {
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
    blockNumber: async () => head,
    getLogs: async () => {
      logCalls += 1;
      if (logsFail) throw new Error("The node refuses a range this wide.");
      return logs;
    },
    blockTime: async (block: number) => {
      if (timeAt) return timeAt(block);
      if (startTime === null) throw new Error("No block time.");
      return startTime;
    },
  }),
}));
vi.mock("./use-tasks", () => ({
  freshTask: async () => fresh,
  useTaskWrite: () => ({
    isPending: false,
    mutate: (
      input: { record: { tags: string[][]; content: string } },
      options?: { onSuccess?: () => void; onError?: (e: Error) => void },
    ) => {
      written.push(input);
      if (recordFails) options?.onError?.(new Error("The server is away."));
      else options?.onSuccess?.();
    },
  }),
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (run: () => void) => run(),
}));

const project = {
  coordinate: COORD,
  author: FOUNDER,
  team: [{ pubkey: MATE }],
} as unknown as Project;
const numbers = {
  chainId: 31337,
  playMoney: true,
  windDown: false,
  runner: { address: WALLET, isPair: false, signers: null },
  contracts: { treasury: TREASURY },
  allowance: { box: 100_000_000n, ratePpm: 1000 },
  money: { pot: 7_322_810_944n },
} as unknown as ProjectNumbers;

/** Accepted work, its pay not on the record. */
function accepted(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "9".repeat(64),
    author: FOUNDER,
    at: 1_800_000_000,
    what: "Translate the guide",
    usd: 40,
    openToAnyone: true,
    worker: TAKER,
    payTo: PAYEE,
    state: "accepted",
    handIn: { id: PIECE, at: 1_800_000_100, note: "done" },
    acceptedBy: FOUNDER,
    acceptedAt: 1_800_000_200,
    paidTx: null,
    ...over,
  };
}

function card(
  task: ProjectTask,
  options: {
    me?: string | null;
    address?: string | null;
    numbers?: ProjectNumbers | null;
    taken?: Set<string>;
  } = {},
) {
  return wrap(
    <TaskCard
      address={options.address === undefined ? WALLET : options.address}
      agents={new Set()}
      me={options.me === undefined ? FOUNDER : options.me}
      numbers={options.numbers === undefined ? numbers : options.numbers}
      operators={new Map()}
      profiles={undefined}
      project={project}
      task={task}
      taken={options.taken}
      team={new Set([FOUNDER, MATE])}
    />,
  );
}

const tagOf = (name: string, i = 0) =>
  written[i]?.record.tags.find((t) => t[0] === name)?.[1];
const pad = (a: string) => addressTopic(a);
function drawLog(to: string, raw: bigint, hash: string) {
  return {
    address: TREASURY,
    topics: [DRAWN, pad(WALLET), pad(to)],
    data: encodeParameters(["uint256", "uint256"], [raw, 1n]),
    blockNumber: "0x10",
    transactionHash: hash,
  };
}

beforeEach(() => {
  sent.length = 0;
  written.length = 0;
  fresh = accepted();
  chainBox = null;
  logs = [];
  recordFails = false;
  logsFail = false;
  head = 100;
  startTime = null;
  timeAt = null;
  logCalls = 0;
  forgetPaid(accepted().id);
  forgetPaid(OTHER_TASK);
});
afterEach(cleanup);

/** Block times on a two-second chain on which the task was accepted at `block`. */
const twoSecondChain = (block: number) => (n: number) =>
  1_800_000_200 + (n - block) * 2;

describe("a search for an earlier payment that cannot be relied on", () => {
  it("offers no bare press when the logs cannot be read, only a way to look again", async () => {
    chainBox = 100_000_000n;
    logsFail = true;
    card(accepted());
    expect(
      (await screen.findByTestId("task-pay-search-short")).textContent,
    ).toMatch(/could not be checked/);
    expect(screen.queryByTestId("task-pay")).toBeNull();
    // A read that failed is not "too old": no way out is offered, only looking again.
    expect(screen.queryByTestId("task-pay-none-paid")).toBeNull();
    expect(sent).toHaveLength(0);
    // Looking again once the node answers brings the press back.
    logsFail = false;
    fireEvent.click(screen.getByTestId("task-pay-look-again"));
    expect(await screen.findByTestId("task-pay")).toBeTruthy();
  });

  it("stops the press, and sends nothing, when the search fails after the page was drawn", async () => {
    chainBox = 100_000_000n;
    card(accepted());
    const button = await screen.findByTestId("task-pay");
    // A Pair's other signer may already have confirmed this very pay; the node now refuses the range.
    logsFail = true;
    fireEvent.click(button);
    expect((await screen.findByTestId("task-pay-problem")).textContent).toMatch(
      /could not be checked/,
    );
    expect(sent).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("goes back further than the first pieces, until it reaches the day of the acceptance, so an old unpaid task can be paid", async () => {
    chainBox = 100_000_000n;
    head = 500_000;
    timeAt = twoSecondChain(200_000); // accepted thirty pieces back
    card(accepted());
    expect(await screen.findByTestId("task-pay")).toBeTruthy();
    expect(logCalls).toBeGreaterThan(20);
    expect(logCalls).toBeLessThan(40);
    fireEvent.click(screen.getByTestId("task-pay"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(1);
  });

  it("finds a payment made long before the page was opened, in an older piece", async () => {
    chainBox = 100_000_000n;
    head = 500_000;
    timeAt = twoSecondChain(200_000);
    logs = [
      { ...drawLog(PAYEE, 40_000_000n, FOUND_TX), blockNumber: "0x30d40" },
    ]; // block 200,000
    card(accepted());
    expect(
      (await screen.findByTestId("task-pay-found")).textContent,
    ).toBeTruthy();
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });

  it("when the acceptance is further back than the bound, offers a way out: say that nothing was paid, and the bare press comes back", async () => {
    chainBox = 100_000_000n;
    head = 5_000_000;
    timeAt = twoSecondChain(100); // far past forty pieces
    card(accepted());
    expect(
      (await screen.findByTestId("task-pay-search-short")).textContent,
    ).toMatch(/so long ago/);
    expect(screen.queryByTestId("task-pay")).toBeNull();
    expect(sent).toHaveLength(0);
    fireEvent.click(screen.getByTestId("task-pay-none-paid"));
    fireEvent.click(await screen.findByTestId("task-pay"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(tagOf("task-paid")).toBe(TX);
  });

  it("when the network gives no block times, the same way out is offered", async () => {
    chainBox = 100_000_000n;
    head = 500_000;
    startTime = null;
    card(accepted());
    expect(await screen.findByTestId("task-pay-search-short")).toBeTruthy();
    expect(screen.queryByTestId("task-pay")).toBeNull();
    fireEvent.click(screen.getByTestId("task-pay-none-paid"));
    expect(await screen.findByTestId("task-pay")).toBeTruthy();
  });

  it("says nothing was paid, yet a payment that appears afterwards still stops the press", async () => {
    chainBox = 100_000_000n;
    head = 5_000_000;
    timeAt = twoSecondChain(100); // far past forty pieces
    card(accepted());
    fireEvent.click(await screen.findByTestId("task-pay-none-paid"));
    const button = await screen.findByTestId("task-pay");
    logs = [drawLog(PAYEE, 40_000_000n, FOUND_TX)];
    fireEvent.click(button);
    expect((await screen.findByTestId("task-pay-problem")).textContent).toMatch(
      /already left the box/,
    );
    expect(sent).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("is enough when it starts before the acceptance, however long the chain is", async () => {
    chainBox = 100_000_000n;
    head = 500_000;
    startTime = 1_800_000_200 - 3_600;
    card(accepted());
    expect(await screen.findByTestId("task-pay")).toBeTruthy();
  });
});
