// A Council seat holder's waiting list: the rows the Council's own logs give, the agreement count from the record's
// threshold, the one Agree per row with its own name, Take back my agreement where this seat agreed, the ran-out rows the
// record no longer counts, and the public line under the list. The chain is stubbed; the calls are decoded and compared.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { COUNCIL_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTS,
  COUNCIL,
  councilRecord,
} from "../../../tests/helpers/council-v2-parse";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import { nameTheNetwork } from "../../../tests/helpers/pot-harness";
import type { ProjectNumbers } from "../money/numbers";
import {
  councilAgreeCall,
  councilWithdrawCall,
} from "@creaton/core/pot/pot-calls.ts";
import {
  agreedLine,
  PUBLIC_LINE,
  RAN_OUT,
  TAKE_BACK_AGREEMENT,
} from "./council-words";
import { PROPOSED_TOPIC } from "./proposals";
import { WaitingActions } from "./WaitingActions";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AGREED_TOPIC = topicOf("Agreed(bytes32,address,uint8)");
const ME = ACCOUNTS[2] as string;
const OTHER = ACCOUNTS[0] as string;
const DRAWN_TO = ACCOUNTS[3] as string;
const DRAW = `0x${topicOf("draw(address,uint256)").slice(2, 10)}`;

const word = (address: string) =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

const id = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

let chain: PotChain;

/** A Council `Proposed` log: the Pair's own event shape, written by this Council. */
function proposed(proposal: string, by: string, block: number) {
  const data =
    DRAW +
    encodeParameters(["address", "uint256"], [DRAWN_TO, 5_000_000n]).slice(2);
  return {
    address: COUNCIL,
    blockNumber: `0x${block.toString(16)}`,
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [TREASURY_ADDRESS, data, 1n],
    ),
    topics: [PROPOSED_TOPIC, proposal, word(by)],
    transactionHash: `0x${"00".repeat(32)}`,
  };
}

/** A Council `Agreed` log: how many seats have agreed after this one. */
function agreed(proposal: string, by: string, count: number, block: number) {
  return {
    address: COUNCIL,
    blockNumber: `0x${block.toString(16)}`,
    data: encodeParameters(["uint8"], [BigInt(count)]),
    topics: [AGREED_TOPIC, proposal, word(by)],
    transactionHash: `0x${"00".repeat(32)}`,
  };
}

const TREASURY_ADDRESS = "0x75537828f2ce51be7289709686a69cbfdbb714f1";

function setup(
  logs: unknown[],
  numbers: ProjectNumbers = councilRecord("voting"),
) {
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: ME,
    answers: {},
    launcher: numbers.launcher,
    logs,
  });
  return numbers;
}

function show(numbers: ProjectNumbers) {
  const council = numbers.council;
  if (!council) throw new Error("the record has no Council");
  return wrap(
    <WaitingActions
      address={ME}
      council={council}
      nameOf={(address) => address.slice(0, 6)}
      numbers={numbers}
    />,
  );
}

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the waiting list of a seat holder", () => {
  it("shows each waiting call in plain words with how many seats have agreed, and one Agree named by its row", async () => {
    setup([proposed(id(1), OTHER, 100), agreed(id(1), OTHER, 1, 100)]);
    show(councilRecord("voting"));
    const row = await screen.findByTestId("council-waiting-row");
    expect(row.textContent).toContain("Draw 5 dollars from the allowance to");
    expect(row.textContent).toContain(agreedLine(1, 3));
    const agree = screen.getByTestId("council-agree");
    expect(agree.getAttribute("aria-label")).toMatch(/^Agree: Draw 5 dollars/);
    expect(screen.getByText(PUBLIC_LINE, { exact: true })).toBeTruthy();
    fireEvent.click(agree);
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const sent = chain.sent[0];
    expect(sent?.to).toBe(COUNCIL);
    const call = decodeCall(COUNCIL_ABI, sent?.data ?? "");
    expect(call?.name).toBe("agree");
    expect(sent?.data).toBe(
      councilAgreeCall(COUNCIL, TREASURY_ADDRESS, expectedDraw(), 1n).data,
    );
  });

  it("says Take back my agreement where this seat agreed, and takes the same call back", async () => {
    setup([proposed(id(2), ME, 100), agreed(id(2), ME, 1, 100)]);
    show(councilRecord("voting"));
    const takeBack = await screen.findByTestId("council-withdraw");
    expect(takeBack.textContent).toBe(TAKE_BACK_AGREEMENT);
    expect(takeBack.getAttribute("aria-label")).toMatch(
      /^Take back my agreement: /,
    );
    fireEvent.click(takeBack);
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0]?.data).toBe(councilWithdrawCall(COUNCIL, id(2)).data);
  });

  it("says an action ran out where the record no longer counts it, and offers no press there", async () => {
    // The record counts one waiting call (councilOf's own count): the older second one has run out.
    setup([
      proposed(id(3), OTHER, 200),
      agreed(id(3), OTHER, 1, 200),
      proposed(id(4), OTHER, 100),
      agreed(id(4), OTHER, 1, 100),
    ]);
    show(councilRecord("voting"));
    await screen.findByTestId("council-waiting-row");
    const ranOut = screen.getAllByTestId("council-waiting-ran-out");
    expect(ranOut).toHaveLength(1);
    expect(ranOut[0]?.textContent).toContain(RAN_OUT);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("council-agree")).toBeTruthy();
  });

  it("says nothing is waiting when no call does", async () => {
    setup([]);
    show(councilRecord("voting"));
    expect(await screen.findByTestId("council-waiting-none")).toBeTruthy();
    expect(screen.queryByTestId("council-agree")).toBeNull();
    expect(screen.queryByText(PUBLIC_LINE)).toBeNull();
  });
});

/** The inner call the fixture proposes: `draw(DRAWN_TO, 5 dollars)`, as its data. */
function expectedDraw(): string {
  return `${DRAW}${encodeParameters(
    ["address", "uint256"],
    [DRAWN_TO, 5_000_000n],
  ).slice(2)}`;
}
