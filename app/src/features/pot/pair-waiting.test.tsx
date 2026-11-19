// The second signer's sheet: the waiting calls are read from the Pair, each is said in a sentence with its names and numbers,
// confirming sends the exact call that was proposed, the one who asked can withdraw it, and a call the app cannot read is
// never offered for confirming.
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { PAIR_ABI } from "@creaton/core/pot/abis.generated.ts";
import { drawCall, setDoorCall } from "@creaton/core/pot/pot-calls.ts";
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
  D,
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
} from "../../../tests/helpers/pot-harness";
import type { ProjectNumbers } from "../money/numbers";
import { PairWaiting } from "./PairWaiting";
import { windowOf } from "./use-pair-waiting";

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
const base = numbersFor();
const numbers: ProjectNumbers = {
  ...base,
  runner: { address: PAIR, isPair: true, signers: [FOUNDER_EVM, BACKER_EVM] },
  contracts: { ...base.contracts, pair: PAIR },
};
const PROPOSED = topicOf("Proposed(bytes32,address,address,bytes,uint256)");
const word = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const NAMES: Record<string, string> = {
  [BACKER_EVM]: "Anna",
  [FOUNDER_EVM]: "Fred",
};
const nameOf = (a: string) => NAMES[a] ?? a;
let chain: PotChain;

/** A `Proposed` log of this Pair. */
function proposed(
  n: number,
  by: string,
  target: string,
  data: string,
  nonce: bigint,
) {
  return {
    address: PAIR,
    topics: [PROPOSED, id(n), word(by)],
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [target, data, nonce],
    ),
    blockNumber: "0x10",
  };
}

const DAY = 86_400;
function setup(
  account: string,
  logs: unknown[],
  proposer: string = FOUNDER_EVM,
) {
  chain = installPotChain({
    account,
    logs,
    answers: {
      proposer: [proposer],
      proposedAt: [BigInt(Math.floor(Date.now() / 1000))],
      PROPOSAL_TTL: [BigInt(14 * DAY)],
    } as never,
  });
}
const show = (address: string = BACKER_EVM, n: ProjectNumbers = numbers) =>
  wrap(<PairWaiting address={address} nameOf={nameOf} numbers={n} />);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the calls waiting for the second signer", () => {
  const DRAW = drawCall({
    treasury: numbers.contracts.treasury,
    to: BACKER_EVM,
    amount: 12n * D,
  });

  it("says what the call does, to whom and how much, and confirms exactly the call proposed", async () => {
    setup(BACKER_EVM, [proposed(1, FOUNDER_EVM, DRAW.to, DRAW.data, 7n)]);
    show();
    const terms = await screen.findByTestId("pair-terms");
    expect(terms.textContent).toBe(
      `Draw 12 dollars from the allowance box to Anna (${BACKER_EVM}).`,
    );
    expect(
      screen.getByText(/Fred asked. It happens when you confirm./),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("pair-review"));
    expect((await screen.findByTestId("pair-sheet-terms")).textContent).toBe(
      terms.textContent,
    );
    expect(screen.getByTestId("pair-sheet-names").textContent).toMatch(
      new RegExp(`Anna: ${BACKER_EVM}`),
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(PAIR);
    const decoded = decodeCall(PAIR_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("confirm");
    expect(decoded?.args).toEqual([DRAW.to, DRAW.data, 7n]);
  });

  it("a draw that pays an accepted task names the task in the list and on the sheet the second signer confirms", async () => {
    setup(BACKER_EVM, [proposed(1, FOUNDER_EVM, DRAW.to, DRAW.data, 7n)]);
    wrap(
      <PairWaiting
        address={BACKER_EVM}
        nameOf={nameOf}
        numbers={numbers}
        tasksFor={(payee, raw) =>
          payee === BACKER_EVM && raw === 12n * D ? ["Translate the guide"] : []
        }
      />,
    );
    const terms = await screen.findByTestId("pair-terms");
    expect(terms.textContent).toBe(
      `Draw 12 dollars from the allowance box to Anna (${BACKER_EVM}), the pay for the task "Translate the guide".`,
    );
    fireEvent.click(screen.getByTestId("pair-review"));
    expect((await screen.findByTestId("pair-sheet-terms")).textContent).toBe(
      terms.textContent,
    );
  });

  it("the one who asked sees it as theirs and can withdraw it", async () => {
    setup(FOUNDER_EVM, [proposed(2, FOUNDER_EVM, DRAW.to, DRAW.data, 8n)]);
    show(FOUNDER_EVM);
    expect(
      await screen.findByText(
        /You asked. It happens when the other signer confirms./,
      ),
    ).not.toBeNull();
    expect(screen.queryByTestId("pair-review")).toBeNull();
    fireEvent.click(screen.getByTestId("pair-withdraw"));
    fireEvent.click(await screen.findByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(PAIR_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("cancel");
    expect(decoded?.args).toEqual([id(2)]);
  });

  it("a call the app cannot read is shown as unknown and cannot be confirmed from here", async () => {
    setup(BACKER_EVM, [
      proposed(
        3,
        FOUNDER_EVM,
        "0x00000000000000000000000000000000000000b2",
        "0xdeadbeef",
        9n,
      ),
    ]);
    show();
    const terms = await screen.findByTestId("pair-terms");
    expect(terms.textContent).toMatch(/A call this app cannot read/);
    expect(screen.queryByTestId("pair-review")).toBeNull();
    expect(screen.getByTestId("pair-cannot-confirm").textContent).toMatch(
      /cannot be confirmed from here/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("each waiting call is its own item, and a spent one is not listed", async () => {
    const door = setDoorCall(numbers.contracts.treasury, false);
    setup(BACKER_EVM, [
      proposed(1, FOUNDER_EVM, DRAW.to, DRAW.data, 1n),
      proposed(2, FOUNDER_EVM, door.to, door.data, 2n),
    ]);
    // The second was confirmed since: the Pair has no proposer for it any more.
    chain.answers.proposer = (args: readonly unknown[]) => [
      args[0] === id(2)
        ? "0x0000000000000000000000000000000000000000"
        : FOUNDER_EVM,
    ];
    show();
    await screen.findAllByTestId("pair-waiting-call");
    expect(screen.getAllByTestId("pair-waiting-call").length).toBe(1);
  });

  it("keeps a call while the Pair's own time limit, read from the Pair and counted on the chain's clock, has not run out", async () => {
    // The chain's clock is 20 days behind the browser's (a moved test chain). The call was proposed 3 days before the
    // chain's now: it waits, although by the browser's clock it would be 17 days old.
    setup(BACKER_EVM, [proposed(1, FOUNDER_EVM, DRAW.to, DRAW.data, 7n)]);
    const nowOnChain = Math.floor(Date.now() / 1000) - 20 * DAY;
    chain.blockTime = nowOnChain;
    chain.answers.proposedAt = [BigInt(nowOnChain - 3 * DAY)];
    show();
    expect((await screen.findAllByTestId("pair-waiting-call")).length).toBe(1);
  });

  it("drops a call that is out of time on the chain's clock, with the limit as the Pair says it", async () => {
    setup(BACKER_EVM, [proposed(1, FOUNDER_EVM, DRAW.to, DRAW.data, 7n)]);
    // This Pair gives a call one day, not two weeks: a call proposed two days ago is out of time.
    chain.answers.PROPOSAL_TTL = [BigInt(DAY)];
    chain.answers.proposedAt = [BigInt(chain.blockTime - 2 * DAY)];
    show();
    expect((await screen.findByTestId("pair-none")).textContent).toBe(
      "Nothing is waiting.",
    );
  });

  it("nothing waiting says so", async () => {
    setup(BACKER_EVM, []);
    show();
    expect((await screen.findByTestId("pair-none")).textContent).toBe(
      "Nothing is waiting.",
    );
  });

  it("when the waiting calls cannot be read it says nothing changed", async () => {
    setup(BACKER_EVM, [proposed(1, FOUNDER_EVM, DRAW.to, DRAW.data, 7n)]);
    chain.answers.proposer = () => {
      throw new Error("down");
    };
    show();
    expect((await screen.findByTestId("pair-read-failed")).textContent).toMatch(
      /Nothing changed/,
    );
  });

  it("someone who is not one of the two signers sees nothing of it", () => {
    setup("0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc", []);
    show("0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc");
    expect(screen.queryByTestId("pair-card")).toBeNull();
  });
});

describe("how far back the waiting calls are looked for", () => {
  it("covers the Pair's limit at the network's own pace, not a fixed count of blocks", () => {
    // 2-second blocks: 14 days is 604,800 blocks, far over the old 50,000; the look back is as wide as it takes, to a cap.
    const slow = windowOf(
      14 * 86_400,
      400_000,
      1_000_000,
      1_000_000 - 2 * 5_000,
      5_000,
    );
    expect(slow.needed).toBeGreaterThan(600_000);
    expect(slow.span).toBe(400_000);
    // 12-second blocks: about 100,800 blocks for 14 days, and a margin.
    const normal = windowOf(
      14 * 86_400,
      5_000_000,
      1_000_000,
      1_000_000 - 12 * 5_000,
      5_000,
    );
    expect(normal.span).toBeGreaterThan(100_800);
    expect(normal.span).toBeLessThan(200_000);
    // A network that cannot say its pace gets the fixed count; blocks within one second say nothing of pace.
    expect(windowOf(14 * 86_400, 5_000_000, 1_000_000, null, 0).span).toBe(
      50_000,
    );
    expect(
      windowOf(14 * 86_400, 5_000_000, 1_000_000, 1_000_000, 5_000).span,
    ).toBe(600_000);
  });
});
