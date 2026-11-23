// The allowance screen for the people who run the project: the box, the ceiling, the rate, an announced raise and the weekly
// check-in with its dates; draw to an address, change the rate (lower at once, raise after the wait), apply it, and the door.
// Each sheet's numbers are the numbers in the call it sends, and with a Pair each step is a proposal for the other signer.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  COUNCIL_ABI,
  PAIR_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
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
import { councilRecord } from "../../../tests/helpers/council-v2-parse";
import { checkInCall, drawCall } from "@creaton/core/pot/pot-calls.ts";
import {
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { addressTopic, topicOf } from "@creaton/core/launchpad/work.ts";
import { dollarsText, type ProjectNumbers } from "../money/numbers";
import { CHECK_IN_NO_RECORD } from "../money/runner";
import { proposeAskLine } from "../council/council-words";
import { AllowanceSection } from "./AllowanceSection";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/week">{children}</a>
  ),
}));

const numbers = numbersFor();
const NOW = numbers.builtAt + 100;
const PAIR = "0x00000000000000000000000000000000000000a1";
const TO = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const SECOND = "0x00000000000000000000000000000000000000dd";
let chain: PotChain;

const allowance = (over: Record<string, unknown> = {}) => ({
  // The never-ask-twice guard reads what waits in the runner before an ask (a Pair's proposals): nothing waits here
  // unless a test plants a log.
  PROPOSAL_TTL: [86_400n],
  box: [700n * D],
  boxCap: [7_000n * D],
  ratePpm: [1_000n],
  pendingRatePpm: [0n],
  pendingAt: [0n],
  lastCheckIn: [BigInt(NOW - 3 * 86_400)],
  activeEnd: [BigInt(NOW + 11 * 86_400)],
  MAX_RATE_PPM: [2_000n],
  unit: [BigInt(numbers.unit)],
  ...over,
});

function setup(account: string, over: Record<string, unknown> = {}) {
  chain = installPotChain({ account, answers: allowance(over) as never });
}
const show = (
  n: ProjectNumbers = numbers,
  address: string | null = FOUNDER_EVM,
) => wrap(<AllowanceSection address={address} now={NOW} numbers={n} />);
const pairRun: ProjectNumbers = {
  ...numbers,
  runner: { address: PAIR, isPair: true, signers: [FOUNDER_EVM, BACKER_EVM] },
  contracts: { ...numbers.contracts, pair: PAIR },
};

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

describe("who sees the allowance screen", () => {
  it("the runner sees the box, its limit, the rate and the ceiling, read from the chain", async () => {
    setup(FOUNDER_EVM);
    show();
    expect((await screen.findByTestId("allowance-box")).textContent).toBe(
      "700 dollars",
    );
    expect(screen.getByTestId("allowance-cap").textContent).toBe(
      "7,000 dollars",
    );
    expect(screen.getByTestId("allowance-rate").textContent).toBe("0.10%");
    expect(screen.getByTestId("allowance-ceiling").textContent).toBe("0.20%");
  });

  it("the box is what the larger of the Treasury's last settle and the server's reading says, so a quiet project can still be drawn from", async () => {
    // The Treasury's stored box is as of its last settle (0 here); the record's box is worked forward to its own time.
    setup(FOUNDER_EVM, { box: [0n] });
    show();
    const box = dollarsText(numbers.allowance.box);
    expect((await screen.findByTestId("allowance-box")).textContent).toBe(
      `${box} dollars`,
    );
    expect(
      (screen.getByTestId("allowance-draw") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("allowance-draw"));
    expect((await screen.findByTestId("draw-box")).textContent).toContain(
      `holds about ${box} dollars`,
    );
  });

  it("an empty box in both readings offers no draw", async () => {
    setup(FOUNDER_EVM, { box: [0n] });
    show({ ...numbers, allowance: { ...numbers.allowance, box: 0n } });
    await screen.findByTestId("allowance-box");
    expect(
      (screen.getByTestId("allowance-draw") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("someone who does not run the project sees nothing of it", () => {
    setup(BACKER_EVM);
    show(numbers, BACKER_EVM);
    expect(screen.queryByTestId("allowance-section")).toBeNull();
  });

  it("says when the weekly check-in is due and what happens if it lapses, with the date", async () => {
    setup(FOUNDER_EVM);
    show();
    const words =
      (await screen.findByTestId("allowance-checkin")).textContent ?? "";
    expect(words).toMatch(/last check-in was on/);
    expect(words).toMatch(/If the team does not check in again by/);
    expect(words).toMatch(
      /box stops filling, new backing stops and Team Shares stop unlocking/,
    );
    expect(words).toMatch(/Backers can always take their money out/);
  });

  it("says a check-in is overdue once its date has passed", async () => {
    setup(FOUNDER_EVM, { activeEnd: [BigInt(NOW - 86_400)] });
    show();
    expect(
      (await screen.findByTestId("allowance-checkin")).textContent,
    ).toMatch(/is overdue/);
  });

  it("a wound-down project has no allowance to run: the screen is gone and no press is offered", () => {
    setup(FOUNDER_EVM);
    show({ ...numbers, windDown: { kind: 1, at: NOW - 10 } });
    expect(screen.queryByTestId("allowance-section")).toBeNull();
    expect(screen.queryByTestId("allowance-draw")).toBeNull();
  });

  it("when the allowance could not be read it says nothing changed and offers to try again", async () => {
    setup(FOUNDER_EVM, {
      box: () => {
        throw new Error("down");
      },
    });
    show();
    expect(
      (await screen.findByTestId("allowance-read-failed")).textContent,
    ).toMatch(/Nothing changed/);
  });
});

describe("the check-in press on the money tab", () => {
  // The press lives beside the runner's other presses because after a hand-over the new runner did not start the
  // project and the This-week page lists nothing for them: this is the only way back for them.
  it("the runner presses and the call goes to the Treasury at once, carrying no week's words", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("allowance-check-in"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0]?.to).toBe(numbers.contracts.treasury);
    expect(decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "")).toMatchObject({
      name: "checkIn",
      args: [CHECK_IN_NO_RECORD],
    });
    expect((await screen.findByTestId("toast")).textContent).toContain(
      "Checked in. The allowance keeps running.",
    );
  });

  it("a Pair signer presses and it checks in at once through the Pair: a Pair lets either signer check in alone", async () => {
    setup(BACKER_EVM);
    show(pairRun, BACKER_EVM);
    const block = await screen.findByTestId("allowance-checkin");
    // No line about asking the other signer: a check-in needs one signer only.
    expect(block.textContent).not.toContain("asks the other signer");
    fireEvent.click(screen.getByTestId("allowance-check-in"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0]?.to).toBe(PAIR);
    expect(decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "")).toMatchObject({
      name: "checkIn",
      args: [CHECK_IN_NO_RECORD],
    });
    expect((await screen.findByTestId("toast")).textContent).toContain(
      "Checked in. The allowance keeps running.",
    );
  });

  it("a Council seat's press is a proposal to the Council, with the seats' threshold in its own numbers", async () => {
    const run = councilRecord("voting");
    const council = run.council;
    if (!council) throw new Error("the record has no Council");
    const seat = council.seats[1]?.account;
    if (!seat) throw new Error("the second seat is open");
    setup(seat);
    show(run, seat);
    const block = await screen.findByTestId("allowance-checkin");
    expect(block.textContent).toContain(
      proposeAskLine(council.needed, council.seats.length),
    );
    fireEvent.click(screen.getByTestId("allowance-check-in"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0]?.to).toBe(council.contract);
    expect(decodeCall(COUNCIL_ABI, chain.sent[0]?.data ?? "")).toMatchObject({
      name: "propose",
      args: [
        run.contracts.treasury,
        checkInCall(run.contracts.treasury, CHECK_IN_NO_RECORD).data,
      ],
    });
    expect((await screen.findByTestId("toast")).textContent).toContain(
      "Asked. It runs when enough seats agree.",
    );
  });
});

describe("draw to an address", () => {
  async function open() {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
  }
  it("says one dollar as 'goes', never '1 dollars go'", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "1" },
    });
    expect(screen.getByTestId("draw-terms").textContent).toBe(
      `1 dollar goes from the box to ${TO}.`,
    );
  });
  it("sends the account and amount shown, and says them in a sentence first", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "25.5" },
    });
    expect(screen.getByTestId("draw-terms").textContent).toBe(
      `25.50 dollars go from the box to ${TO}.`,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(numbers.contracts.treasury);
    const decoded = decodeCall(TREASURY_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("draw");
    expect(decoded?.args).toEqual([TO, 25_500_000n]);
  });
  it("more than the box holds is refused on the sheet, with how much it holds", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "701" },
    });
    expect(
      screen.getByText(/The box holds about 700 dollars now/, {
        selector: "p[role=alert]",
      }),
    ).not.toBeNull();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });
  it("never offers more than the box holds at most: money set aside for a task lowers that cap before the box's figure moves", async () => {
    setup(FOUNDER_EVM, { box: [700n * D], boxCap: [600n * D] });
    show();
    fireEvent.click(await screen.findByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
    expect(screen.getByTestId("draw-box").textContent).toContain(
      "holds about 600 dollars",
    );
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "650" },
    });
    expect(
      screen.getByText(/The box holds about 600 dollars now/, {
        selector: "p[role=alert]",
      }),
    ).not.toBeNull();
    expect(chain.sent).toEqual([]);
  });
  it("something that is not an account address says what an address looks like", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: "Anna" },
    });
    expect(
      screen.getByText(/starts with 0x and has 42 characters/),
    ).not.toBeNull();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the rate", () => {
  async function open(over: Record<string, unknown> = {}) {
    setup(FOUNDER_EVM, over);
    show();
    fireEvent.click(await screen.findByTestId("allowance-rate-open"));
    await screen.findByTestId("rate-now");
  }
  it("a lower rate is set at once, and says so", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("New rate"), {
      target: { value: "0.05" },
    });
    expect(screen.getByTestId("rate-terms").textContent).toMatch(
      /takes effect at once/,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(TREASURY_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("setRate");
    expect(decoded?.args).toEqual([500n]);
  });
  it("a higher rate is announced first, says it waits, and sends the announcement", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("New rate"), {
      target: { value: "0.15" },
    });
    expect(screen.getByTestId("rate-terms").textContent).toMatch(
      /announced first.*7 days/,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(TREASURY_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("proposeRate");
    expect(decoded?.args).toEqual([1_500n]);
  });
  it("a rate above the ceiling, or the one in place, is refused on the sheet", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("New rate"), {
      target: { value: "0.5" },
    });
    expect(screen.getByText(/The most allowed is 0\.20% a day/)).not.toBeNull();
    fireEvent.change(screen.getByLabelText("New rate"), {
      target: { value: "0.10" },
    });
    expect(screen.getByText(/That is the rate now/)).not.toBeNull();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });
  it("an announced raise waits for its date, with the date, and applies after it", async () => {
    setup(FOUNDER_EVM, {
      pendingRatePpm: [1_500n],
      // Announced a day short of one time unit ago: it can be applied (announced at + one unit) a day from now.
      pendingAt: [BigInt(NOW + 86_400 - numbers.unit)],
    });
    show();
    expect(
      (await screen.findByTestId("allowance-pending")).textContent,
    ).toMatch(/0\.15% a day was announced.*You can apply it from/);
    fireEvent.click(screen.getByTestId("allowance-apply"));
    expect((await screen.findByTestId("apply-wait")).textContent).toMatch(
      /can be applied from/,
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });
  it("once the wait is over the raise is applied", async () => {
    setup(FOUNDER_EVM, {
      pendingRatePpm: [1_500n],
      pendingAt: [BigInt(NOW - 60 - numbers.unit)],
    });
    show();
    fireEvent.click(await screen.findByTestId("allowance-apply"));
    expect((await screen.findByTestId("apply-ready")).textContent).toMatch(
      /Applying sets the allowance to 0\.15%/,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(decodeCall(TREASURY_ABI, chain.sent[0].data)?.name).toBe(
      "applyRate",
    );
  });
});

describe("the door", () => {
  it("closing it says people can still take their money out, and sends setDoor(false)", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("allowance-door"));
    expect((await screen.findByTestId("door-words")).textContent).toMatch(
      /still take their money out/,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(TREASURY_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("setDoor");
    expect(decoded?.args).toEqual([false]);
  });
});

describe("a project run by two", () => {
  it("a signer's draw is a proposal to the Pair for the exact call, and says the other signer must confirm", async () => {
    setup(FOUNDER_EVM);
    show(pairRun);
    expect((await screen.findByTestId("allowance-pair")).textContent).toMatch(
      /asks the other signer/,
    );
    fireEvent.click(screen.getByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(PAIR);
    const proposal = decodeCall(PAIR_ABI, chain.sent[0].data);
    expect(proposal?.name).toBe("propose");
    expect(proposal?.args[0]).toBe(numbers.contracts.treasury);
    const inner = decodeCall(TREASURY_ABI, proposal?.args[1] as string);
    expect(inner?.name).toBe("draw");
    expect(inner?.args).toEqual([TO, 10n * D]);
  });
});

/** The event a Pair and a Council both write when a call is put forward for the others to agree to. */
const PROPOSED = topicOf("Proposed(bytes32,address,address,bytes,uint256)");

describe("the same draw is never asked twice", () => {
  // A Pair and a Council give every proposal its own id, so a second identical ask would draw twice. What already
  // waits is read before the press; nothing is sent when the same call is among it.
  it("a draw already waiting in the Pair is not asked again: the press sends nothing and says so", async () => {
    const now = Math.floor(Date.now() / 1000);
    setup(BACKER_EVM, {
      proposer: () => [SECOND],
      proposedAt: [BigInt(now)],
    });
    show(pairRun, BACKER_EVM);
    fireEvent.click(await screen.findByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "1" },
    });
    // What an earlier press left waiting in the Pair: the exact call this sheet is about to ask for.
    const inner = drawCall({
      treasury: numbers.contracts.treasury,
      to: TO,
      amount: D,
    });
    chain.logs = [
      {
        address: PAIR,
        topics: [PROPOSED, `0x${"01".repeat(32)}`, addressTopic(SECOND)],
        data: encodeParameters(
          ["address", "bytes", "uint256"],
          [inner.to, inner.data, 1n],
        ),
        blockNumber: "0x10",
        transactionHash: `0x${"ee".repeat(32)}`,
      },
    ];
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("sheet-problem").textContent).toContain(
        "already waiting for the other signer",
      ),
    );
    expect(chain.sent).toEqual([]);
  });

  it("a draw already waiting in the Council is not asked again, and the words name the seats", async () => {
    const run = councilRecord("voting");
    const council = run.council;
    if (!council) throw new Error("the record has no Council");
    const seat = council.seats[1]?.account;
    if (!seat) throw new Error("the second seat is open");
    const now = Math.floor(Date.now() / 1000);
    // The Council's own proposals view answers by selector (its shape is the Pair's plus a generation and a mask).
    chain = installPotChain({
      account: seat,
      answers: { ...allowance(), generation: [1n] } as never,
      answersBySelector: {
        [selectorOf("proposals(bytes32)")]: () =>
          encodeParameters(
            ["uint48", "uint32", "uint8"],
            [BigInt(now), 1n, 1n],
          ),
      },
    });
    show(run, seat);
    fireEvent.click(await screen.findByTestId("allowance-draw"));
    await screen.findByTestId("draw-box");
    fireEvent.change(screen.getByLabelText("Draw to which account?"), {
      target: { value: TO },
    });
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "1" },
    });
    const inner = drawCall({
      treasury: run.contracts.treasury,
      to: TO,
      amount: D,
    });
    chain.logs = [
      {
        address: council.contract,
        topics: [PROPOSED, `0x${"01".repeat(32)}`, addressTopic(seat)],
        data: encodeParameters(
          ["address", "bytes", "uint256"],
          [inner.to, inner.data, 0n],
        ),
        blockNumber: "0x10",
        transactionHash: `0x${"ee".repeat(32)}`,
      },
    ];
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("sheet-problem").textContent).toContain(
        "already waiting for the seats",
      ),
    );
    expect(chain.sent).toEqual([]);
  });
});
