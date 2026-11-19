// Accepted now, paid later: an accepted task whose pay is not on its record reads "accepted, pay owed" to everyone and never as
// paid; the runner pays it from the box on the task itself, and that payment is written on the task (linked to it, with the
// recovery of a payment whose record failed); a Pair's signer asks for it and the other signer reads which task it is for;
// a payment already made is found and offered, never paid twice.
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { PAIR_ABI, TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { addressTopic, topicOf } from "@creaton/core/launchpad/work.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { forgetPaid, paidNotRecorded, rememberPaid } from "./paid-journal";
import type { ProjectTask } from "./task-record";
import { TaskCard } from "./TaskCard";

const FOUNDER = "f".repeat(64);
const MATE = "e".repeat(64);
const TAKER = "a".repeat(64);
const STRANGER = "d".repeat(64);
const COORD = `37001:${FOUNDER}:orbit`;
const PAYEE = "0x00000000000000000000000000000000000000cd";
const WALLET = "0x00000000000000000000000000000000000000ee";
const SECOND = "0x00000000000000000000000000000000000000dd";
const PAIR = "0x00000000000000000000000000000000000000ff";
const TX = `0x${"ab".repeat(32)}`;
const FOUND_TX = `0x${"cd".repeat(32)}`;
const PIECE = "1".repeat(64);
const TREASURY = "0x20b6000000000000000000000000000000000906";
const DRAWN = topicOf("AllowanceDrawn(address,address,uint256,uint256)");

const sent: { chainId: number; build: () => { to: string; data: string }[] }[] =
  [];
const written: { record: { tags: string[][]; content: string } }[] = [];
let fresh: ProjectTask | null;
let chainBox: bigint | null = null;
let logs: unknown[] = [];
let recordFails = false;

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
    blockNumber: async () => 100,
    getLogs: async () => logs,
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
const pairNumbers = {
  ...numbers,
  runner: { address: PAIR, isPair: true, signers: [WALLET, SECOND] },
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
  forgetPaid(accepted().id);
});
afterEach(cleanup);

describe("an accepted task whose pay is owed", () => {
  it("reads 'accepted, pay owed' to everyone, and never as paid", () => {
    for (const viewer of [
      { me: FOUNDER, address: WALLET },
      { me: TAKER, address: PAYEE },
      { me: STRANGER, address: null },
      { me: null, address: null },
    ]) {
      card(accepted(), viewer);
      expect(screen.getByTestId("task-pay-owed").textContent).toBe(
        "Accepted, pay owed: 40 dollars.",
      );
      expect(screen.queryByTestId("task-paid")).toBeNull();
      expect(screen.queryByTestId("task-pays")).toBeNull();
      cleanup();
    }
  });

  it("with the payment on its record it reads 'paid', and offers nothing to pay", () => {
    card(accepted({ paidTx: TX }));
    expect(screen.getByTestId("task-paid").textContent).toBe(
      "Paid 40 dollars.",
    );
    expect(screen.queryByTestId("task-pay-owed")).toBeNull();
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });

  it("with money off says nothing about money", () => {
    card(accepted(), { numbers: null });
    expect(screen.queryByTestId("task-pay-owed")).toBeNull();
    expect(screen.queryByTestId("task-paid")).toBeNull();
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });

  it("is paid from the task by the runner: one draw to the worker's wallet, and the payment is written on this task", async () => {
    card(accepted());
    const button = await screen.findByTestId("task-pay");
    expect(button.textContent).toBe("Pay from the box");
    expect(screen.getByTestId("task-pay-terms").textContent).toContain(PAYEE);
    expect(screen.getByTestId("task-play-money").textContent).toMatch(
      /play money/,
    );
    fireEvent.click(button);
    await waitFor(() => expect(written).toHaveLength(1));
    // One draw, from the Treasury, of exactly what the task pays, to the wallet the worker named.
    expect(sent).toHaveLength(1);
    const [call] = sent[0]?.build() ?? [];
    expect(call?.to).toBe(TREASURY);
    expect(decodeCall(TREASURY_ABI, call?.data ?? "")?.args).toEqual([
      PAYEE,
      40_000_000n,
    ]);
    // The record is a confirmation of this task's accepted piece that carries the payment: the pay is linked to the task.
    expect(tagOf("task-part")).toBe("confirm");
    expect(tagOf("task")).toBe(accepted().id);
    expect(tagOf("task-evidence")).toBe(PIECE);
    expect(tagOf("task-paid")).toBe(TX);
    expect(paidNotRecorded(accepted().id)).toBeNull();
  });

  it("keeps a payment whose record failed, and the next press writes the record and never pays again", async () => {
    recordFails = true;
    card(accepted());
    fireEvent.click(await screen.findByTestId("task-pay"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(paidNotRecorded(accepted().id)?.txHash).toBe(TX);
    expect(screen.getByTestId("task-pay-problem").textContent).toMatch(
      /nothing is paid twice/,
    );
    cleanup();
    recordFails = false;
    card(accepted());
    fireEvent.click(await screen.findByTestId("task-pay-save"));
    await waitFor(() => expect(written).toHaveLength(2));
    expect(sent).toHaveLength(1);
    expect(tagOf("task-paid", 1)).toBe(TX);
    expect(tagOf("task-evidence", 1)).toBe(PIECE);
    expect(paidNotRecorded(accepted().id)).toBeNull();
  });

  it("with the box short offers no press, and says how much it holds", async () => {
    card(accepted(), {
      numbers: {
        ...numbers,
        allowance: { box: 39_999_999n, ratePpm: 1000 },
      } as unknown as ProjectNumbers,
    });
    expect(
      (await screen.findByTestId("task-pay-box-short")).textContent,
    ).toMatch(/holds 39.99 dollars now.*Pay it when the box holds enough/);
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });

  it("stops before sending when the chain's box, read again at the press, has fallen short", async () => {
    // The record is hours old and says the box is low; the chain's own box was enough when the page drew.
    chainBox = 45_000_000n;
    card(accepted(), {
      numbers: {
        ...numbers,
        allowance: { box: 10_000_000n, ratePpm: 1000 },
      } as unknown as ProjectNumbers,
    });
    const button = await screen.findByTestId("task-pay");
    // Someone drew from the box after the page was drawn.
    chainBox = 20_000_000n;
    fireEvent.click(button);
    expect((await screen.findByTestId("task-pay-problem")).textContent).toMatch(
      /box holds 20 dollars now/,
    );
    expect(sent).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("looks at the task again first: a task already paid meanwhile is not paid again", async () => {
    card(accepted());
    const button = await screen.findByTestId("task-pay");
    fresh = accepted({ paidTx: FOUND_TX });
    fireEvent.click(button);
    await screen.findByTestId("task-pay-problem");
    expect(screen.getByTestId("task-pay-problem").textContent).toMatch(
      /changed while you were looking/,
    );
    expect(sent).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("offers no press to a wallet that does not run the project, and says so", () => {
    card(accepted(), { address: PAYEE });
    expect(screen.getByTestId("task-pay-not-runner").textContent).toMatch(
      /Only the wallet that runs this project/,
    );
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });

  it("offers no press to the person who did the work, nor to someone outside the team", () => {
    card(accepted(), { me: TAKER });
    expect(screen.queryByTestId("task-pay-section")).toBeNull();
    cleanup();
    card(accepted(), { me: STRANGER });
    expect(screen.queryByTestId("task-pay-section")).toBeNull();
  });

  it("says when the worker named no wallet that nothing can be sent", () => {
    card(accepted({ payTo: null }));
    expect(screen.getByTestId("task-pay-no-payee").textContent).toMatch(
      /named no wallet/,
    );
    expect(screen.queryByTestId("task-pay")).toBeNull();
  });
});

describe("a payment already made", () => {
  it("is found on the chain and offered for this task, and nothing is paid twice", async () => {
    logs = [drawLog(PAYEE, 40_000_000n, FOUND_TX)];
    card(accepted());
    expect((await screen.findByTestId("task-pay-found")).textContent).toMatch(
      /A payment of 40 dollars to 0x0+cd left the box/,
    );
    expect(screen.queryByTestId("task-pay")).toBeNull();
    fireEvent.click(screen.getByTestId("task-pay-save"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(0);
    expect(tagOf("task-paid")).toBe(FOUND_TX);
    expect(tagOf("task-evidence")).toBe(PIECE);
  });

  it("is not offered when another task already carries it", async () => {
    logs = [drawLog(PAYEE, 40_000_000n, FOUND_TX)];
    card(accepted(), { taken: new Set([FOUND_TX]) });
    expect(await screen.findByTestId("task-pay")).toBeTruthy();
    expect(screen.queryByTestId("task-pay-found")).toBeNull();
  });

  it("of another amount or to another wallet is not this task's", async () => {
    logs = [
      drawLog(PAYEE, 39_000_000n, FOUND_TX),
      drawLog(SECOND, 40_000_000n, FOUND_TX),
    ];
    card(accepted());
    expect(await screen.findByTestId("task-pay")).toBeTruthy();
    expect(screen.queryByTestId("task-pay-found")).toBeNull();
  });

  it("can be said to be for something else, and then the task is paid from the box", async () => {
    logs = [drawLog(PAYEE, 40_000_000n, FOUND_TX)];
    card(accepted());
    fireEvent.click(await screen.findByTestId("task-pay-elsewhere"));
    fireEvent.click(await screen.findByTestId("task-pay"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(tagOf("task-paid")).toBe(TX);
  });

  it("makes the press stop when a payment appeared since the page was drawn", async () => {
    card(accepted());
    const button = await screen.findByTestId("task-pay");
    logs = [drawLog(PAYEE, 40_000_000n, FOUND_TX)];
    fireEvent.click(button);
    await screen.findByTestId("task-pay-problem");
    expect(screen.getByTestId("task-pay-problem").textContent).toMatch(
      /already left the box/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("a project run by two", () => {
  it("asks the other signer for the pay, through the Pair, and writes nothing until it has run", async () => {
    card(accepted(), { numbers: pairNumbers });
    const button = await screen.findByTestId("task-pay");
    expect(button.textContent).toBe("Ask for the pay from the box");
    expect(screen.getByTestId("task-pay-section").textContent).toMatch(
      /run by two/,
    );
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveLength(1));
    const [call] = sent[0]?.build() ?? [];
    expect(call?.to).toBe(PAIR);
    const proposal = decodeCall(PAIR_ABI, call?.data ?? "");
    expect(proposal?.name).toBe("propose");
    expect(String(proposal?.args[0]).toLowerCase()).toBe(TREASURY);
    expect(decodeCall(TREASURY_ABI, String(proposal?.args[1]))?.args).toEqual([
      PAYEE,
      40_000_000n,
    ]);
    expect((await screen.findByTestId("task-pay-asked")).textContent).toMatch(
      /when the other signer confirms/,
    );
    expect(written).toHaveLength(0);
    expect(screen.getByTestId("task-pay-owed").textContent).toBe(
      "Accepted, pay owed: 40 dollars.",
    );
  });

  it("once the other signer confirmed, the payment is found and saved on the task", async () => {
    logs = [drawLog(PAYEE, 40_000_000n, FOUND_TX)];
    card(accepted(), { numbers: pairNumbers });
    fireEvent.click(await screen.findByTestId("task-pay-save"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(tagOf("task-paid")).toBe(FOUND_TX);
    expect(sent).toHaveLength(0);
  });
});

describe("a journal kept from an earlier press", () => {
  it("is used even when the chain cannot be searched", async () => {
    rememberPaid({ task: accepted().id, handIn: PIECE, txHash: TX, at: 1 });
    card(accepted());
    fireEvent.click(await screen.findByTestId("task-pay-save"));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(tagOf("task-paid")).toBe(TX);
    expect(sent).toHaveLength(0);
  });
});
