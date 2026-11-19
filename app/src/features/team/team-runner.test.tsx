// The runner seat on Project > Money through the components: who is offered Hand over and Wind down, the exact call each
// sends (straight from a runner alone, as a proposal from a signer of the Pair), the founder's leaving choice, and
// taking a seat that was offered.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressWord,
  installChainStub,
} from "../../../tests/helpers/chain-stub";
import {
  accountOf,
  linkedWalletRecord,
} from "../../../tests/helpers/linked-wallet";
import {
  COORDINATE,
  NOW,
  numbersOf,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  CONTRACTS,
  chainIdentity,
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { TeamMoney } from "./TeamMoney";
import { TeamTop } from "./TeamTop";
import {
  directCall,
  handOverData,
  pairProposeCall,
  takeSeatCall,
  windDownData,
} from "./team-calls";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const STRANGER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const MATE_KEY = "b7".repeat(32);
const MATE = accountOf(MATE_KEY);
const NEXT_KEY = "c3".repeat(32);
const NEXT = accountOf(NEXT_KEY);
const FOUNDER = COORDINATE.split(":")[1];
const { key: KEY } = chainIdentity(COORDINATE);
const PAIR_READS = {
  "first()": `0x${addressWord(FOUNDER_EVM)}`,
  "second()": `0x${addressWord(BACKER_EVM)}`,
};

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

function numbers(o: {
  runner?: string;
  stage?: "solo" | "backed" | "team" | "council" | "open";
  woundDown?: boolean;
}) {
  const paired = o.runner === PAIR;
  const content = numbersContent({
    coordinate: COORDINATE,
    now: NOW,
    stage: paired ? "team" : "backed",
    runner: o.runner ?? FOUNDER_EVM,
  });
  if (paired)
    content.contracts = {
      ...(content.contracts as Record<string, unknown>),
      pair: PAIR,
    };
  if (o.stage)
    content.stage = { name: o.stage, since: NOW - 86_400, openAt: null };
  if (o.woundDown)
    content.clock = {
      ...(content.clock as Record<string, unknown>),
      woundDown: true,
    };
  return numbersOf(content);
}

const show = (n: ReturnType<typeof numbers>, team = [FOUNDER, MATE]) =>
  wrap(<TeamMoney numbers={n} profiles={{}} team={team} />);

/** Rendered and settled with no runner card on the page. */
async function expectNoCard() {
  await new Promise((r) => setTimeout(r, 60));
  expect(screen.queryByTestId("runner-card")).toBeNull();
  expect(screen.queryByTestId("hand-over")).toBeNull();
  expect(screen.queryByTestId("wind-down")).toBeNull();
}

describe("handing the runner seat over", () => {
  it("offers the seat straight from a runner alone, to the wallet the teammate linked, once per press", async () => {
    serve([linkedWalletRecord(MATE_KEY, BACKER_EVM)]);
    const stub = installChainStub({ account: FOUNDER_EVM });
    show(numbers({}));
    fireEvent.click(await screen.findByTestId("hand-over"));
    const confirm = await screen.findByTestId("hand-over-sheet-confirm");
    // Nobody chosen yet: nothing to send.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.sent).toEqual([
      {
        from: FOUNDER_EVM,
        to: CONTRACTS.treasury,
        data: handOverData(BACKER_EVM, false),
      },
    ]);
  });

  it("says the founder leaves only when the founder ticks it", async () => {
    serve([linkedWalletRecord(MATE_KEY, BACKER_EVM)]);
    const stub = installChainStub({ account: FOUNDER_EVM });
    show(numbers({}));
    fireEvent.click(await screen.findByTestId("hand-over"));
    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("hand-over-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toBe(handOverData(BACKER_EVM, true));
  });

  it("gives a later runner who is not the founder no leaving choice", async () => {
    serve([linkedWalletRecord(NEXT_KEY, STRANGER)]);
    const stub = installChainStub({ account: BACKER_EVM });
    show(numbers({ runner: BACKER_EVM }), [FOUNDER, MATE, NEXT]);
    fireEvent.click(await screen.findByTestId("hand-over"));
    fireEvent.click(await screen.findByRole("radio"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByTestId("hand-over-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toBe(handOverData(STRANGER, false));
  });

  it("asks through the Pair from one of its signers, never offering the seat to the signer's own wallet", async () => {
    serve([
      linkedWalletRecord(MATE_KEY, BACKER_EVM),
      linkedWalletRecord(NEXT_KEY, STRANGER),
    ]);
    const stub = installChainStub({ account: BACKER_EVM, reads: PAIR_READS });
    show(numbers({ runner: PAIR }), [FOUNDER, MATE, NEXT]);
    fireEvent.click(await screen.findByTestId("hand-over"));
    const choices = await screen.findAllByRole("radio");
    // Only the third teammate: the signer's own wallet is not a choice.
    expect(choices.length).toBe(1);
    fireEvent.click(choices[0]);
    const confirm = screen.getByTestId("hand-over-sheet-confirm");
    expect(confirm.textContent).toBe("Ask your co-signer to confirm");
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0]).toEqual({
      from: BACKER_EVM,
      to: PAIR,
      data: pairProposeCall(
        PAIR,
        CONTRACTS.treasury,
        handOverData(STRANGER, false),
      ).data,
    });
  });

  it("asks for a linked wallet first when no teammate has one", async () => {
    installChainStub({ account: FOUNDER_EVM });
    show(numbers({}));
    expect((await screen.findByTestId("runner-card")).textContent).toMatch(
      /a teammate first links their wallet on You/,
    );
    expect(screen.queryByTestId("hand-over")).toBeNull();
  });
});

describe("winding down", () => {
  it("winds down straight from a runner alone, on the second press only", async () => {
    const stub = installChainStub({ account: FOUNDER_EVM });
    show(numbers({}));
    fireEvent.click(await screen.findByTestId("wind-down"));
    expect(stub.sent.length).toBe(0);
    const confirm = await screen.findByTestId("wind-down-sheet-confirm");
    expect(screen.getByTestId("wind-down-sheet").textContent).toMatch(
      /This cannot be undone/,
    );
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.sent).toEqual([
      {
        from: FOUNDER_EVM,
        to: CONTRACTS.launcher,
        data: windDownData(KEY),
      },
    ]);
  });

  it("asks through the Pair from one of its signers", async () => {
    const stub = installChainStub({ account: FOUNDER_EVM, reads: PAIR_READS });
    show(numbers({ runner: PAIR }));
    fireEvent.click(await screen.findByTestId("wind-down"));
    fireEvent.click(await screen.findByTestId("wind-down-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0]).toEqual({
      from: FOUNDER_EVM,
      to: PAIR,
      data: pairProposeCall(PAIR, CONTRACTS.launcher, windDownData(KEY)).data,
    });
  });

  it.each([
    "council",
    "open",
  ] as const)("is not offered once a market exists (%s), while Hand over still is", async (stage) => {
    serve([linkedWalletRecord(MATE_KEY, BACKER_EVM)]);
    installChainStub({ account: FOUNDER_EVM });
    show(numbers({ stage }));
    fireEvent.click(await screen.findByTestId("hand-over"));
    expect(screen.queryByTestId("wind-down")).toBeNull();
    // After a market the founder's Shares follow their own release: no leaving choice.
    await screen.findByRole("radio");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("who sees the runner seat", () => {
  it("shows nothing to a wallet that neither runs the project nor signs for its Pair", async () => {
    serve([linkedWalletRecord(MATE_KEY, BACKER_EVM)]);
    installChainStub({ account: STRANGER });
    show(numbers({}));
    await expectNoCard();
    cleanup();
    installChainStub({ account: STRANGER, reads: PAIR_READS });
    show(numbers({ runner: PAIR }));
    await expectNoCard();
  });

  it("shows nothing once the project wound down", async () => {
    serve([linkedWalletRecord(MATE_KEY, BACKER_EVM)]);
    installChainStub({ account: FOUNDER_EVM });
    show(numbers({ woundDown: true }));
    await expectNoCard();
  });
});

describe("taking an offered seat", () => {
  const top = (n: ReturnType<typeof numbers>) =>
    wrap(
      <TeamTop
        founder={FOUNDER}
        numbers={n}
        profiles={{}}
        team={[FOUNDER, MATE]}
      />,
    );

  it("takes the seat offered to this wallet itself, once per press", async () => {
    const stub = installChainStub({
      account: BACKER_EVM,
      reads: { "pendingRunner()": `0x${addressWord(BACKER_EVM)}` },
    });
    top(numbers({}));
    const accept = await screen.findByTestId("seat-accept");
    expect(accept.textContent).toBe("Take the seat");
    fireEvent.click(accept);
    const confirm = await screen.findByTestId("seat-sheet-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.sent).toEqual([
      {
        from: BACKER_EVM,
        to: CONTRACTS.treasury,
        data: takeSeatCall(CONTRACTS.treasury).data,
      },
    ]);
    expect(takeSeatCall(CONTRACTS.treasury)).toEqual(
      directCall(CONTRACTS.treasury, takeSeatCall(CONTRACTS.treasury).data),
    );
  });

  it("takes a seat a Pair offered too, and offers nothing to a wallet it was not offered to", async () => {
    const stub = installChainStub({
      account: STRANGER,
      reads: {
        ...PAIR_READS,
        "pendingRunner()": `0x${addressWord(STRANGER)}`,
      },
    });
    top(numbers({ runner: PAIR }));
    fireEvent.click(await screen.findByTestId("seat-accept"));
    fireEvent.click(await screen.findByTestId("seat-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toBe(takeSeatCall(CONTRACTS.treasury).data);
    cleanup();
    installChainStub({
      account: STRANGER,
      reads: { "pendingRunner()": `0x${addressWord(BACKER_EVM)}` },
    });
    top(numbers({}));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByTestId("seat-accept")).toBeNull();
  });
});
