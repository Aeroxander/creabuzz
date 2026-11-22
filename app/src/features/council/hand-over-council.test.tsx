// "Hand over to a Council" from the seat section: the third choice in the hand-over sheet, its five account fields (typed,
// named, or filled by a paste of five), the plan's sentences, the offer call it sends, and the make press that follows it
// once the Treasury holds the offer — compared with the calls the core module builds, never retyped.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { handOverCall } from "@creaton/core/pot/pot-calls.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { COUNCIL_ABI, TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTS,
  councilRecord,
  ruleOf,
  VOTE,
} from "../../../tests/helpers/council-v2-parse";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
} from "../../../tests/helpers/pot-harness";
import {
  ANNA,
  MEMBERS,
  nameOf,
  seatAnswers,
} from "../../../tests/helpers/seat-harness";
import type { ProjectNumbers } from "../money/numbers";
import { handOverIntro } from "./council-words";
import { SeatSection } from "../seat/SeatSection";

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

/** The Council the five accounts of the test make: what the Launcher answers for their address. */
const COUNCIL_ADDRESS = "0x00000000000000000000000000000000000000c5";

/** A project run by the founder alone whose record carries the vote (the Council is switched on for its network). */
function numbersWithVote(): ProjectNumbers {
  return councilRecord("voting", (r) => {
    r.contracts.pause = VOTE;
    r.runner = { address: FOUNDER_EVM, isPair: false, signers: null };
    delete r.council;
    r.vote = {
      contract: VOTE,
      rule: ruleOf(),
      open: null,
      next: {
        seatsAt: null,
        replaceFrom: r.asOf.time,
        openFloor: "50000000000000000000000",
      },
    };
  });
}

let chain: PotChain;
let numbers: ProjectNumbers;
const NOW = () => numbers.asOf.time;

function setup() {
  numbers = numbersWithVote();
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: FOUNDER_EVM,
    launcher: numbers.launcher,
    answers: seatAnswers(numbers, NOW()) as never,
    answersBySelector: {
      // The address the five make: a fixed-size array argument this stub's decoder cannot name.
      [selectorOf("councilAddress(bytes32,address[5],bytes32)")]: () =>
        encodeParameters(["address"], [COUNCIL_ADDRESS]),
    },
  });
  // The Treasury holds the offer once the hand-over lands; the Launcher makes the seated Council once makeCouncil lands.
  chain.onSend = (tx) => {
    const treasury = decodeCall(TREASURY_ABI, tx.data);
    if (treasury?.name === "handOver") {
      chain.answers.pendingRunner = [COUNCIL_ADDRESS];
      return;
    }
    if (
      tx.data
        .toLowerCase()
        .startsWith(selectorOf("makeCouncil(bytes32,address[5],bytes32)"))
    )
      chain.answers.runner = [COUNCIL_ADDRESS];
  };
}

function show() {
  return wrap(
    <SeatSection
      members={MEMBERS}
      nameOf={nameOf}
      now={NOW()}
      numbers={numbers}
      projectName="Lantern"
    />,
  );
}

async function openCouncilSheet() {
  fireEvent.click(await screen.findByTestId("seat-hand-over"));
  fireEvent.click(await screen.findByTestId("offer-council"));
  return screen.findByTestId("council-offer-sheet");
}

const field = (n: number) => screen.getByTestId(`council-offer-field-${n}`);
const fill = (n: number, value: string) =>
  fireEvent.change(field(n), { target: { value } });
const fillFive = async () => {
  for (const [i, account] of ACCOUNTS.entries()) fill(i + 1, account);
  await waitFor(() =>
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
};

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("hand over to a Council", () => {
  it("is the third choice in the hand-over sheet, says what it does, and sends the offer to the Council's address", async () => {
    setup();
    show();
    const sheet = await openCouncilSheet();
    // The plan's own sentence, from the record's threshold and seats.
    expect(
      sheet.querySelector('[data-testid="council-offer-intro"]')?.textContent,
    ).toBe(handOverIntro(3, 5));
    expect(screen.getByText("Seat 1")).toBeTruthy();
    expect(screen.getByText("Seat 5")).toBeTruthy();
    // Nothing is sent until all five accounts are there.
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    await fillFive();
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    // Each field says what it understood: the account's short address.
    expect(field(1).getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const sent = chain.sent[0];
    expect(sent?.to).toBe(numbers.contracts.treasury);
    const call = decodeCall(TREASURY_ABI, sent?.data ?? "");
    expect(call?.name).toBe("handOver");
    expect(call?.args[0]).toBe(COUNCIL_ADDRESS);
    expect(call?.args[1]).toBe(false);
  });

  it("becomes Make the Council once the Treasury holds the offer, and that press makes it", async () => {
    setup();
    show();
    await openCouncilSheet();
    await fillFive();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    // The offer lands and the sheet stays for its second step.
    const make = await screen.findByText("Make the Council");
    expect(make).toBeTruthy();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
    const sent = chain.sent[1];
    expect(sent?.to).toBe(numbers.launcher);
    // The call's words, read by hand: the selector, the project's key, the five accounts in order, and a salt.
    const words = (sent?.data ?? "").slice(10);
    expect((sent?.data ?? "").slice(0, 10)).toBe(
      selectorOf("makeCouncil(bytes32,address[5],bytes32)"),
    );
    expect(words).toHaveLength((1 + 5 + 1) * 64);
    expect(`0x${words.slice(0, 64)}`).toBe(numbers.key);
    const five = [0, 1, 2, 3, 4].map(
      (i) => `0x${words.slice((1 + i) * 64 + 24, (1 + i) * 64 + 64)}`,
    );
    expect(five).toEqual(ACCOUNTS.map((a) => a.toLowerCase()));
    expect(`0x${words.slice(6 * 64)}`).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("fills all five fields from a paste of five addresses", async () => {
    setup();
    show();
    await openCouncilSheet();
    fireEvent.paste(field(1), {
      clipboardData: { getData: () => ACCOUNTS.join("\n") },
    });
    for (const [i, account] of ACCOUNTS.entries())
      expect((field(i + 1) as HTMLInputElement).value).toBe(account);
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("takes an account by the name the project shows it under", async () => {
    setup();
    show();
    await openCouncilSheet();
    fill(1, "Anna");
    expect((field(1) as HTMLInputElement).value).toBe("Anna");
    expect(field(1).getAttribute("aria-describedby")).toBeTruthy();
  });

  it("says the offer ran out and offers the seat again instead of leaving a press that cannot run", async () => {
    setup();
    show();
    await openCouncilSheet();
    await fillFive();
    // The offer lands but the chain does not hold it (it ran out at once): the sheet says so and offers again.
    chain.onSend = null;
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(await screen.findByTestId("council-ran-out")).toBeTruthy();
    expect(screen.getByText("Offer the seat")).toBeTruthy();
  });

  it("is not offered on a project whose record carries no vote (the Council is not switched on)", async () => {
    numbers = councilRecord("voting", (r) => {
      r.contracts.pause = null;
      r.runner = { address: FOUNDER_EVM, isPair: false, signers: null };
      delete r.council;
      r.vote = null;
    });
    nameTheNetwork(numbers);
    chain = installPotChain({
      account: FOUNDER_EVM,
      launcher: numbers.launcher,
      answers: seatAnswers(numbers, NOW()) as never,
    });
    show();
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    expect(screen.queryByTestId("offer-council")).toBeNull();
  });
});

// A Council seat's own "Hand over the seat": the Council is the runner, so the press is a proposal to the other seats
// (option (b) of this round: the seat presses this round wires are listed in the round report).
describe("a Council seat handing the runner seat on", () => {
  it("sends a proposal through the Council, not a call to the Treasury", async () => {
    const record = councilRecord("voting");
    const council = record.council;
    if (!council) throw new Error("the record has no Council");
    numbers = record;
    nameTheNetwork(record);
    chain = installPotChain({
      account: ACCOUNTS[2] as string,
      launcher: record.launcher,
      answers: seatAnswers(record, record.asOf.time) as never,
    });
    wrap(
      <SeatSection
        members={MEMBERS}
        nameOf={nameOf}
        now={record.asOf.time}
        numbers={record}
        projectName="Lantern"
      />,
    );
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    const select = (await screen.findByTestId(
      "offer-member",
    )) as HTMLSelectElement;
    const anna = [...select.options].find((o) => o.textContent === "Anna");
    if (!anna) throw new Error("Anna is not offered");
    fireEvent.change(select, { target: { value: anna.value } });
    const confirm = (await screen.findByTestId(
      "sheet-confirm",
    )) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    // The sheet says the presses ask the other seats; it is the same sentence the waiting list uses.
    expect(screen.getByTestId("offer-proposal").textContent).toBe(
      "This asks the other seats to agree. It runs when 3 of five have agreed.",
    );
    fireEvent.click(confirm);
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const sent = chain.sent[0];
    expect(sent?.to).toBe(council.contract);
    const call = decodeCall(COUNCIL_ABI, sent?.data ?? "");
    expect(call?.name).toBe("propose");
    // What it proposes is exactly the hand-over the one-person sheet would have sent.
    const inner = handOverCall({
      treasury: record.contracts.treasury,
      next: ANNA,
      founderLeaves: false,
    });
    expect(call?.args[0]).toBe(inner.to);
    expect(call?.args[1]).toBe(inner.data);
  });
});
