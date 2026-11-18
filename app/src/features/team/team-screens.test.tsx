// Team's screens through the components themselves: who gets which press, the exact calls each press sends, and the
// guards (a double press, a wallet that may not, a call the app cannot name, a call already confirmed).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { chainKeyFromTags } from "@creaton/core/launchpad/project-chain.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountOf,
  linkedWalletRecord,
} from "../../../tests/helpers/linked-wallet";
import {
  COORDINATE,
  NOW,
  numbersOf,
  published,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  addressWord,
  installChainStub,
  word,
} from "../../../tests/helpers/chain-stub";
import {
  BACKER_EVM,
  CONTRACTS,
  chainIdentity,
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { DEFAULT_SHARES_PER_RAW_DOLLAR } from "../money/calls";
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { LaunchProject } from "./LaunchProject";
import { PairCard } from "./PairCard";
import { PROPOSED_TOPIC } from "./pair";
import { PersonTeamActions } from "./PersonTeamActions";
import {
  directCall,
  giveSharesData,
  handOverData,
  launchCall,
  makePairCall,
  openRoundData,
  pairCancelCall,
  pairConfirmCall,
  pairProposeCall,
} from "./team-calls";
import { TeamTop } from "./TeamTop";
import { checkInTarget } from "./use-team";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const STRANGER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const { key: KEY } = chainIdentity(COORDINATE);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
  published.length = 0;
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

const solo = () =>
  numbersOf(numbersContent({ coordinate: COORDINATE, now: NOW }));
const team = () => {
  const content = numbersContent({
    coordinate: COORDINATE,
    now: NOW,
    stage: "team",
    runner: PAIR,
  });
  content.contracts = {
    ...(content.contracts as Record<string, unknown>),
    pair: PAIR,
  };
  return numbersOf(content);
};
const pair = { address: PAIR, first: FOUNDER_EVM, second: BACKER_EVM };

describe("the second seat", () => {
  const MATE_KEY = "b7".repeat(32);
  const MATE = accountOf(MATE_KEY);
  const founderKey = COORDINATE.split(":")[1];

  it("lets the founder who runs it offer the seat to the Pair of the two of them, once per press", async () => {
    serve([linkedWalletRecord(MATE_KEY, BACKER_EVM)]);
    const stub = installChainStub({
      account: FOUNDER_EVM,
      reads: {
        "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
      },
    });
    wrap(
      <TeamTop
        founder={founderKey}
        numbers={solo()}
        profiles={{}}
        team={[founderKey, MATE]}
      />,
    );
    fireEvent.click(await screen.findByTestId("offer-seat"));
    const confirm = await screen.findByTestId("offer-seat-sheet-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    const offer = directCall(CONTRACTS.treasury, handOverData(PAIR, false));
    expect(stub.sent[0]).toEqual({
      from: FOUNDER_EVM,
      to: offer.to,
      data: offer.data,
    });
  });

  it("offers the seat only from the wallet that runs the project, and only to a linked wallet", async () => {
    serve([]);
    installChainStub({ account: STRANGER });
    wrap(
      <TeamTop
        founder={founderKey}
        numbers={solo()}
        profiles={{}}
        team={[founderKey, MATE]}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("second-seat")).toBeNull();
    cleanup();
    installChainStub({ account: FOUNDER_EVM });
    wrap(
      <TeamTop
        founder={founderKey}
        numbers={solo()}
        profiles={{}}
        team={[founderKey, MATE]}
      />,
    );
    expect((await screen.findByTestId("no-wallet")).textContent).toMatch(
      /not linked a wallet/,
    );
    expect(screen.queryByTestId("offer-seat")).toBeNull();
  });

  it("lets the second person accept the seat offered to the Pair of them and the runner", async () => {
    const stub = installChainStub({
      account: BACKER_EVM,
      reads: {
        "pendingRunner()": `0x${addressWord(PAIR)}`,
        "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
      },
    });
    wrap(
      <TeamTop
        founder={"a".repeat(64)}
        numbers={solo()}
        profiles={{}}
        team={[]}
      />,
    );
    fireEvent.click(await screen.findByTestId("seat-accept"));
    fireEvent.click(await screen.findByTestId("seat-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].to).toBe(CONTRACTS.launcher);
    expect(stub.sent[0].data).toBe(
      makePairCall(CONTRACTS.launcher, KEY, FOUNDER_EVM).data,
    );
  });

  it("shows no offer when the seat was offered to another Pair", async () => {
    installChainStub({
      account: BACKER_EVM,
      reads: {
        "pendingRunner()": `0x${addressWord(STRANGER)}`,
        "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
      },
    });
    wrap(
      <TeamTop
        founder={"a".repeat(64)}
        numbers={solo()}
        profiles={{}}
        team={[]}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("seat-accept")).toBeNull();
  });
});

describe("Give Shares", () => {
  it("gives straight from a runner alone, and through the Pair from a signer", async () => {
    const stub = installChainStub({ account: BACKER_EVM });
    wrap(
      <PersonTeamActions
        me={BACKER_EVM}
        name="Fay"
        numbers={team()}
        pair={pair}
        wallet={{ state: "linked", address: STRANGER }}
      />,
    );
    // A signer of the Pair gets Give Shares but never the second seat (the project is already Team).
    expect(screen.queryByTestId("offer-seat")).toBeNull();
    fireEvent.click(screen.getByTestId("give-shares"));
    const confirm = await screen.findByTestId("give-sheet-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("give-choice-1"));
    expect(screen.getByTestId("give-review").textContent).toMatch(
      /released evenly over 365 days from the day a market opens/,
    );
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].to).toBe(PAIR);
    expect(stub.sent[0].data).toBe(
      pairProposeCall(
        PAIR,
        CONTRACTS.treasury,
        giveSharesData(STRANGER, 1_000_000n * 10n ** 18n),
      ).data,
    );
  });
});

describe("the Pair's waiting calls", () => {
  const proposal = (by: string, data: string, nonce: bigint) => ({
    address: PAIR,
    topics: [PROPOSED_TOPIC, `0x${word(nonce + 1n)}`, `0x${addressWord(by)}`],
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [CONTRACTS.treasury, data, nonce],
    ),
    blockNumber: "0x10",
  });

  it("confirms the other signer's call with its exact target, data and nonce, and withdraws one's own", async () => {
    const gift = giveSharesData(STRANGER, 100_000n * 10n ** 18n);
    const stub = installChainStub({
      account: BACKER_EVM,
      logs: () => [
        proposal(FOUNDER_EVM, gift, 4n),
        proposal(BACKER_EVM, openRoundData(KEY, 1n), 5n),
        // A call the app cannot name: never offered for confirming.
        proposal(FOUNDER_EVM, "0xdeadbeef", 6n),
        // Confirmed already: its proposer is zero, so it is not listed.
        proposal(FOUNDER_EVM, gift, 7n),
      ],
      reads: {
        "proposer(bytes32)": (_to, data) =>
          data.endsWith(word(8n))
            ? `0x${word(0)}`
            : `0x${addressWord(FOUNDER_EVM)}`,
      },
    });
    wrap(
      <PairCard
        me={BACKER_EVM}
        nameOf={(a) => (a === STRANGER ? "Rae" : "Fay")}
        numbers={team()}
        pair={pair}
      />,
    );
    const calls = await screen.findAllByTestId("pair-waiting-call");
    expect(calls.length).toBe(3);
    expect(calls[0].textContent).toMatch(/Give 100,000 Shares to Rae/);
    expect(screen.getAllByTestId("pair-confirm").length).toBe(1);
    fireEvent.click(screen.getByTestId("pair-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toBe(
      pairConfirmCall(PAIR, CONTRACTS.treasury, gift, 4n).data,
    );
    fireEvent.click(screen.getByTestId("pair-withdraw"));
    await waitFor(() => expect(stub.sent.length).toBe(2));
    expect(stub.sent[1].data).toBe(pairCancelCall(PAIR, `0x${word(6n)}`).data);
  });

  it("opens a backing round at Team in one press, as a proposal both sign", async () => {
    const stub = installChainStub({ account: FOUNDER_EVM });
    const numbers = team();
    numbers.rounds.forEach((r) => {
      r.closed = true;
    });
    numbers.raised = {
      total: 10_000_000_000n,
      cap: 50_000_000_000n,
      left: 40_000_000_000n,
    };
    wrap(
      <PairCard
        me={FOUNDER_EVM}
        nameOf={() => "Sam"}
        numbers={numbers}
        pair={pair}
      />,
    );
    expect((await screen.findByTestId("pair-round")).textContent).toMatch(
      /up to 40,000 dollars/,
    );
    fireEvent.click(screen.getByTestId("pair-open-round"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toBe(
      pairProposeCall(
        PAIR,
        CONTRACTS.launcher,
        openRoundData(KEY, DEFAULT_SHARES_PER_RAW_DOLLAR),
      ).data,
    );
  });

  it("is not shown to a wallet that does not sign for the Pair", () => {
    installChainStub({ account: STRANGER });
    const { container } = wrap(
      <PairCard
        me={STRANGER}
        nameOf={() => "x"}
        numbers={team()}
        pair={pair}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("where a check-in goes", () => {
  it("goes to the Treasury for the runner, the Pair for its signers, and nowhere for anyone else", () => {
    expect(checkInTarget(solo(), FOUNDER_EVM, null)).toBe(CONTRACTS.treasury);
    expect(checkInTarget(team(), BACKER_EVM, pair)).toBe(PAIR);
    expect(
      checkInTarget(
        team(),
        FOUNDER_EVM.toUpperCase().replace("0X", "0x"),
        pair,
      ),
    ).toBe(PAIR);
    expect(checkInTarget(team(), STRANGER, pair)).toBeNull();
    expect(checkInTarget(solo(), BACKER_EVM, null)).toBeNull();
  });
});

describe("putting a project on the network", () => {
  const project = () => {
    const [, author, id] = COORDINATE.split(":");
    return {
      id,
      author,
      coordinate: COORDINATE,
      name: "Lantern lamps",
      pitch: "",
      image: null,
      startedAt: NOW - 86_400,
      updatedAt: NOW - 86_400,
      team: [],
      formerTeam: [],
      event: {
        id: "e".repeat(64),
        pubkey: author,
        kind: 37001,
        created_at: NOW - 86_400,
        tags: [
          ["d", id],
          ["name", "Lantern lamps"],
        ],
        content: '{"pitch":"x"}',
      },
    } as unknown as Parameters<typeof LaunchProject>[0]["project"];
  };

  it("launches with the hash it read, then names the launch in the founder's record", async () => {
    vi.stubEnv("VITE_CREATON_LAUNCHER", CONTRACTS.launcher);
    vi.stubEnv("VITE_CREATON_CHAIN_ID", "31337");
    const stub = installChainStub({
      account: FOUNDER_EVM,
      reads: {
        "launchHash(bytes32)": `0x${word(0xabcn)}`,
        "projectByKey(bytes32)": `0x${word(0).repeat(7)}`,
      },
    });
    wrap(<LaunchProject project={project()} />);
    fireEvent.click(await screen.findByTestId("launch-press"));
    await waitFor(() => expect(published.length).toBe(1));
    const { projectId, key } = chainIdentity(COORDINATE, FOUNDER_EVM);
    expect(stub.sent[0].data).toBe(
      launchCall({
        launcher: CONTRACTS.launcher,
        projectId,
        name: "Lantern lamps",
        symbol: "LANTERNLAMP",
        settingsHash: `0x${word(0xabcn)}`,
      }).data,
    );
    const record = published[0] as { tags: string[][]; content: string };
    expect(chainKeyFromTags(record.tags)).toBe(key);
    expect(record.tags).toContainEqual(["name", "Lantern lamps"]);
    expect(record.content).toBe('{"pitch":"x"}');
    vi.unstubAllEnvs();
  });

  it("offers only the link when the launch is already on the network from this wallet", async () => {
    vi.stubEnv("VITE_CREATON_LAUNCHER", CONTRACTS.launcher);
    vi.stubEnv("VITE_CREATON_CHAIN_ID", "31337");
    const stub = installChainStub({
      account: FOUNDER_EVM,
      reads: {
        "projectByKey(bytes32)": `0x${addressWord(FOUNDER_EVM)}${addressWord(CONTRACTS.shares)}${word(0).repeat(5)}`,
      },
    });
    wrap(<LaunchProject project={project()} />);
    const press = await screen.findByTestId("launch-press");
    await waitFor(() => expect(press.textContent).toBe("Finish linking"));
    fireEvent.click(press);
    await waitFor(() => expect(published.length).toBe(1));
    expect(stub.sent.length).toBe(0);
    vi.unstubAllEnvs();
  });
});
