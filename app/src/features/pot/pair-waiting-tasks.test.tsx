// The second signer's list for the four task calls: each is read out from the task as the network has it now, a call that
// names a task the network cannot show is never offered for confirming, and confirming sends exactly the call proposed.
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { PAIR_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  acceptTaskCall,
  announceTaskCall,
  cancelTaskCall,
} from "@creaton/core/pot/pot-calls.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  FOUNDER_EVM,
  nameTheNetwork,
} from "../../../tests/helpers/pot-harness";
import {
  sceneAnswers,
  TAKEN_SERIAL,
  takenNumbers,
  takenRowOf,
  WORKER_WALLET,
} from "../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../money/numbers";
import { PairWaiting } from "./PairWaiting";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
}));

const PAIR = "0x00000000000000000000000000000000000000a1";
const PROPOSED = topicOf("Proposed(bytes32,address,address,bytes,uint256)");
const word = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const DAY = 86_400;
const NAMES: Record<string, string> = {
  [BACKER_EVM]: "Anna",
  [FOUNDER_EVM]: "Fred",
  [WORKER_WALLET]: "Pat",
};
const nameOf = (a: string) => NAMES[a] ?? a;
const WHAT = `0x${"7".repeat(64)}`;

let chain: PotChain;
let numbers: ProjectNumbers;

function proposed(
  n: number,
  call: { to: string; data: string },
  nonce: bigint,
) {
  return {
    address: PAIR,
    topics: [PROPOSED, id(n), word(FOUNDER_EVM)],
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [call.to, call.data, nonce],
    ),
    blockNumber: "0x10",
  };
}

function setup(logs: unknown[], answers: Record<string, unknown> = {}) {
  const base = takenNumbers();
  numbers = {
    ...base,
    runner: { address: PAIR, isPair: true, signers: [FOUNDER_EVM, BACKER_EVM] },
    contracts: { ...base.contracts, pair: PAIR },
  };
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: BACKER_EVM,
    logs,
    answers: {
      ...sceneAnswers(numbers),
      proposer: [FOUNDER_EVM],
      proposedAt: [BigInt(Math.floor(Date.now() / 1000))],
      PROPOSAL_TTL: [BigInt(14 * DAY)],
      ...answers,
    } as never,
  });
}
const show = (taskWordsOf?: (what: string) => string | null) =>
  wrap(
    <PairWaiting
      address={BACKER_EVM}
      nameOf={nameOf}
      numbers={numbers}
      taskWordsOf={taskWordsOf}
    />,
  );

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("task calls waiting for the second signer", () => {
  it("pay: says who is paid and what is set aside from the network, and confirms exactly the call proposed", async () => {
    setup([]);
    const call = acceptTaskCall({
      treasury: numbers.contracts.treasury,
      serial: BigInt(TAKEN_SERIAL),
      payDollars: 12_500_000n,
    });
    chain.logs = [proposed(1, call, 7n)];
    show();
    const terms = await screen.findByTestId("pair-terms");
    expect(terms.textContent).toMatch(
      new RegExp(
        `^Pay 12\\.50 dollars of the [\\d.,]+ dollars set aside for task ${TAKEN_SERIAL} to Pat \\(${WORKER_WALLET}\\)\\. What is left goes back to the project and to those who took out while it was set aside\\.$`,
      ),
    );
    expect(chain.reads.map((r) => r.name)).toContain("taskOf");
    fireEvent.click(screen.getByTestId("pair-review"));
    expect((await screen.findByTestId("pair-sheet-terms")).textContent).toBe(
      terms.textContent,
    );
    expect(screen.getByTestId("pair-sheet-names").textContent).toContain(
      WORKER_WALLET,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const decoded = decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "");
    expect(decoded?.name).toBe("confirm");
    expect(decoded?.args).toEqual([call.to, call.data, 7n]);
  });

  it("plan: reads the notice for this share from the network and says the date counts from the confirming", async () => {
    setup([]);
    const call = announceTaskCall({
      treasury: numbers.contracts.treasury,
      what: WHAT,
      payee: WORKER_WALLET,
      maxDollars: 40_000_000n,
      shareBps: 70,
    });
    chain.logs = [proposed(2, call, 8n)];
    show((what) => (what === WHAT ? "Translate the guide" : null));
    const terms = await screen.findByTestId("pair-terms");
    expect(terms.textContent).toMatch(
      new RegExp(
        `^Plan a task: pay up to 40 dollars to Pat \\(${WORKER_WALLET}\\), at most 0\\.7% of the project's money\\. Holders get 14 days notice, so it can be taken from .+; if nobody takes it within 7 days it lapses; once taken it is due 14 days later\\.$`,
      ),
    );
    const notice = chain.reads.find((r) => r.name === "noticeFor");
    expect(notice?.args).toEqual([70n]);
    const more = screen
      .getAllByTestId("pair-terms-more")
      .map((n) => n.textContent);
    expect(more).toEqual([
      "The date counts from when you confirm.",
      "The task: “Translate the guide”",
    ]);
  });

  it("withdraw: a task that was taken meanwhile is said to have changed and cannot be confirmed", async () => {
    setup([]);
    const call = cancelTaskCall({
      treasury: numbers.contracts.treasury,
      serial: BigInt(TAKEN_SERIAL),
    });
    chain.logs = [proposed(3, call, 9n)];
    show();
    expect((await screen.findByTestId("pair-terms")).textContent).toMatch(
      /has changed since it was asked: it is now taken/,
    );
    expect(screen.queryByTestId("pair-review")).toBeNull();
    expect(screen.getByTestId("pair-cannot-confirm")).toBeTruthy();
  });

  it("a task the network cannot show is never offered for confirming", async () => {
    setup([]);
    const call = acceptTaskCall({
      treasury: numbers.contracts.treasury,
      serial: BigInt(TAKEN_SERIAL),
      payDollars: 1_000_000n,
    });
    chain.logs = [proposed(4, call, 10n)];
    chain.answers.taskOf = () => {
      throw new Error("node hiccup");
    };
    show();
    expect((await screen.findByTestId("pair-terms")).textContent).toBe(
      "This is about a task whose details could not be read from the network, so it cannot be confirmed from here. Try again in a moment.",
    );
    expect(screen.queryByTestId("pair-review")).toBeNull();
    expect(screen.getByTestId("pair-cannot-confirm")).toBeTruthy();
  });

  it("the work behind the pay is in the project's own words only when the task ties to a record here", async () => {
    setup([]);
    const row = takenRowOf(numbers);
    const call = acceptTaskCall({
      treasury: numbers.contracts.treasury,
      serial: row.serial,
      payDollars: 2_000_000n,
    });
    chain.logs = [proposed(5, call, 11n)];
    show((what) => (what === row.what ? "Translate the guide" : null));
    await screen.findByTestId("pair-terms");
    expect(screen.getByTestId("pair-terms-more").textContent).toBe(
      "The task: “Translate the guide”",
    );
  });
});
