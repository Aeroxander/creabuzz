// Who runs the money, and the offers of the seat: what a visitor reads, what the runner can do, what the person the seat is
// offered to can do, what a stranger can do once the team has been quiet for half a year, and what a person who is not
// part of it never sees. Each sheet's call is decoded and compared with what its sheet said.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  aloneNumbers,
  ANNA,
  CARL_EVM,
  MEMBERS,
  nameOf,
  PAIR_OF_ANNA,
  pairNumbers,
  type SeatChain,
  seatAnswers,
  ZERO,
} from "../../../tests/helpers/seat-harness";
import type { ProjectNumbers } from "../money/numbers";
import { SeatSection } from "./SeatSection";

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

const alone = aloneNumbers();
const NOW = alone.builtAt + 100;
let chain: PotChain;

function setup(
  account: string,
  seat: SeatChain = {},
  numbers: ProjectNumbers = alone,
) {
  nameTheNetwork(numbers);
  chain = installPotChain({
    account,
    launcher: numbers.launcher,
    answers: seatAnswers(numbers, NOW, seat) as never,
  });
  return numbers;
}
const show = (numbers: ProjectNumbers = alone, now = NOW) =>
  wrap(
    <SeatSection
      members={MEMBERS}
      nameOf={nameOf}
      now={now}
      numbers={numbers}
      projectName="Lantern"
    />,
  );
const text = (id: string) => screen.getByTestId(id).textContent ?? "";
const treasuryCall = (index = 0) => {
  const call = chain.sent[index];
  if (!call) throw new Error("nothing was sent");
  const found = decodeCall(TREASURY_ABI, call.data);
  if (!found) throw new Error("not a Treasury call");
  return { to: call.to, ...found };
};

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("who runs the money, for anyone", () => {
  it("says who runs it, with no wallet and no question asked of one", async () => {
    setup(BACKER_EVM);
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    show();
    expect(text("seat-runs")).toBe(
      "Fred runs the project's money: draws the allowance, changes the rules and can hand the seat over or wind the project down.",
    );
    expect(screen.queryByTestId("seat-runner")).toBeNull();
    expect(screen.queryByTestId("seat-take")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says that two run it together, and what that means, in one sentence", async () => {
    setup(CARL_EVM, {}, pairNumbers());
    show(pairNumbers());
    expect(text("seat-runs")).toBe(
      "Fred and Anna run the project's money together. Every step that moves money needs both of them to agree.",
    );
    expect(text("seat-pair-meaning")).toMatch(
      /^Running it together means both of you must agree to every step that moves money or changes a rule/,
    );
    expect(text("seat-pair-meaning")).toMatch(
      /Either of you can still check in alone\.$/,
    );
  });

  it("a stranger sees no buttons while the project is open", async () => {
    setup(CARL_EVM);
    show();
    await waitFor(() => expect(chain.reads.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when the project has wound down, and offers nothing", () => {
    setup(FOUNDER_EVM);
    const wound = { ...alone, windDown: { kind: 1 as const, at: NOW - 10 } };
    show(wound);
    expect(text("seat-runs")).toMatch(/has wound down/);
    expect(screen.queryByTestId("seat-runner")).toBeNull();
  });

  it("when the chain says it wound down before the record did, says so and offers nothing", async () => {
    setup(FOUNDER_EVM, { windDownKind: 1 });
    show();
    expect((await screen.findByTestId("seat-wound-down")).textContent).toMatch(
      /has wound down/,
    );
    expect(screen.queryByTestId("seat-wind-down")).toBeNull();
  });

  it("says when the seat could not be read, sends nothing, and tries again", async () => {
    setup(FOUNDER_EVM);
    const answers = chain.answers;
    chain.answers = {
      ...answers,
      runner: () => {
        throw { code: -32603, message: "network down" };
      },
    } as never;
    show();
    expect((await screen.findByTestId("seat-read-failed")).textContent).toMatch(
      /could not be read from the network, so nothing can be sent/,
    );
    chain.answers = answers;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("seat-runner");
    expect(chain.sent).toEqual([]);
  });
});

describe("the runner", () => {
  it("running it alone, sees Hand over, Run it together and Wind down, and no Withdraw", async () => {
    setup(FOUNDER_EVM);
    show();
    await screen.findByTestId("seat-runner");
    expect(screen.getByTestId("seat-hand-over").textContent).toBe(
      "Hand over the seat",
    );
    expect(screen.getByTestId("seat-pair").textContent).toBe(
      "Run it together with someone",
    );
    expect(screen.getByTestId("seat-wind-down").textContent).toBe("Wind down");
    expect(screen.queryByTestId("seat-withdraw")).toBeNull();
    expect(screen.queryByTestId("seat-offer-open")).toBeNull();
  });

  it("one of a pair sees Hand over and Wind down, and no way to make another pair", async () => {
    const numbers = pairNumbers();
    setup(FOUNDER_EVM, {}, numbers);
    show(numbers);
    await screen.findByTestId("seat-runner");
    expect(screen.getByTestId("seat-hand-over")).not.toBeNull();
    expect(screen.queryByTestId("seat-pair")).toBeNull();
    expect(screen.getByTestId("seat-wind-down")).not.toBeNull();
  });

  it("with an offer open to Anna, says so with its end, and offers only to withdraw it", async () => {
    setup(FOUNDER_EVM, { offeredTo: ANNA });
    show();
    const open = await screen.findByTestId("seat-offer-open");
    expect(open.textContent).toMatch(
      /^The seat is offered to Anna\. The offer ends .* Until it is taken you still run the money\.$/,
    );
    expect(screen.getByTestId("seat-withdraw").textContent).toBe(
      "Withdraw the offer",
    );
    expect(screen.queryByTestId("seat-hand-over")).toBeNull();
    expect(screen.queryByTestId("seat-pair")).toBeNull();
  });

  it("an offer to a pair is read as an offer to the person who would make it, by name", async () => {
    setup(FOUNDER_EVM, { offeredTo: PAIR_OF_ANNA });
    show();
    expect((await screen.findByTestId("seat-offer-open")).textContent).toMatch(
      /^The seat is offered to Anna, to run it together with you\./,
    );
  });

  it("an offer that ended says so, takes the offer buttons off Withdraw and offers a new one", async () => {
    // 2 time units of 1,680 seconds are 3,360: this offer was made 4,000 seconds ago.
    setup(FOUNDER_EVM, { offeredTo: ANNA, madeAgo: 4_000 });
    show();
    const open = await screen.findByTestId("seat-offer-open");
    expect(open.textContent).toMatch(
      /The offer ended on .* Nobody can take it now\./,
    );
    expect(open.textContent).not.toMatch(/still run the money/);
    expect(screen.queryByTestId("seat-withdraw")).toBeNull();
    expect(screen.getByTestId("seat-hand-over")).not.toBeNull();
  });

  it("withdraws the offer with one call to nobody, and says what it does first", async () => {
    setup(FOUNDER_EVM, { offeredTo: ANNA });
    show();
    fireEvent.click(await screen.findByTestId("seat-withdraw"));
    const sheet = await screen.findByTestId("withdraw-sheet");
    expect(within(sheet).getByTestId("withdraw-terms").textContent).toBe(
      "Anna can no longer take the seat. Nothing else changes: you keep running the project's money.",
    );
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = treasuryCall();
    expect(call.to).toBe(alone.contracts.treasury);
    expect(call.args).toEqual([ZERO, false]);
  });
});

describe("the person the seat is offered to", () => {
  it("reads the offer and takes the seat with one call, after reading what changes", async () => {
    setup(ANNA, { offeredTo: ANNA, leaves: true });
    show();
    const card = await screen.findByTestId("seat-offered-to-me");
    expect(card.textContent).toMatch(
      /Fred offered you the seat that runs Lantern's money\./,
    );
    fireEvent.click(screen.getByTestId("seat-take"));
    const sheet = await screen.findByTestId("take-seat-sheet");
    const terms =
      within(sheet).getByTestId("take-seat-terms").textContent ?? "";
    expect(terms).toMatch(
      /draws the allowance, changes the rules, grants Team Shares and can wind the project down/,
    );
    expect(terms).toMatch(/Helpers the earlier runner set up stop working/);
    expect(terms).toMatch(
      /The founder is leaving: they give up the part of their own Team Shares that has not unlocked yet/,
    );
    expect(within(sheet).getByTestId("take-seat-ends").textContent).toMatch(
      /^The offer lasts about 56 minutes, until /,
    );
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = treasuryCall();
    expect(call.to).toBe(alone.contracts.treasury);
    expect(call.name).toBe("takeSeat");
  });

  it("is not told about the founder leaving when the offer does not say so", async () => {
    setup(ANNA, { offeredTo: ANNA });
    show();
    fireEvent.click(await screen.findByTestId("seat-take"));
    const sheet = await screen.findByTestId("take-seat-sheet");
    expect(text("take-seat-terms")).not.toMatch(/founder is leaving/);
    expect(sheet).not.toBeNull();
  });

  it("is asked to run it together, reads what that means, and accepts with the call that names the one who asked", async () => {
    setup(ANNA, { offeredTo: PAIR_OF_ANNA });
    show();
    const card = await screen.findByTestId("seat-offered-pair");
    expect(card.textContent).toMatch(
      /Fred asked you to run Lantern's money together\./,
    );
    fireEvent.click(screen.getByTestId("seat-accept"));
    const sheet = await screen.findByTestId("take-seat-sheet");
    expect(sheet.textContent).toMatch(
      /both of you must agree to every step that moves money/,
    );
    expect(sheet.textContent).toMatch(/Accepting makes the two of you a pair/);
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const sent = chain.sent[0];
    const call = decodeCall(LAUNCHER_ABI, sent?.data ?? "");
    expect(sent?.to).toBe(alone.launcher);
    expect(call?.name).toBe("makePair");
    expect(call?.args).toEqual([alone.key, FOUNDER_EVM]);
  });

  it("is offered nothing when the offer is for someone else", async () => {
    setup(ANNA, { offeredTo: CARL_EVM });
    show();
    await waitFor(() => expect(chain.reads.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("seat-offered-to-me")).toBeNull();
    expect(screen.queryByTestId("seat-offered-pair")).toBeNull();
    expect(screen.queryByTestId("seat-take")).toBeNull();
  });

  it("is offered nothing once the offer has ended", async () => {
    setup(ANNA, { offeredTo: ANNA, madeAgo: 4_000 });
    show();
    await waitFor(() => expect(chain.reads.length).toBeGreaterThan(5));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("seat-take")).toBeNull();
  });

  it("a refusal on the chain is said in words, not as a code, and the press stays", async () => {
    setup(ANNA, { offeredTo: ANNA });
    show();
    fireEvent.click(await screen.findByTestId("seat-take"));
    const sheet = await screen.findByTestId("take-seat-sheet");
    chain.refuse = "execution reverted: OfferExpired()";
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    const problem = await within(sheet).findByTestId("sheet-problem");
    expect(problem.textContent).not.toMatch(/OfferExpired|0x/);
    expect(problem.textContent).toMatch(/offer/i);
    expect(
      (within(sheet).getByTestId("sheet-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(chain.sent).toEqual([]);
  });
});

describe("the sheets cannot send twice and give focus back", () => {
  it("a double press on a sheet sends once", async () => {
    setup(ANNA, { offeredTo: ANNA });
    show();
    fireEvent.click(await screen.findByTestId("seat-take"));
    const press = await screen.findByTestId("sheet-confirm");
    fireEvent.click(press);
    fireEvent.click(press);
    fireEvent.click(press);
    await waitFor(() => expect(chain.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(chain.sent.length).toBe(1);
  });

  it("a call that went out and has not landed is looked up, never sent again, and the press says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup(FOUNDER_EVM, { offeredTo: ANNA });
    chain.holdReceipts = true;
    show();
    fireEvent.click(await screen.findByTestId("seat-withdraw"));
    const sheet = await screen.findByTestId("withdraw-sheet");
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    // The wallet's wait runs out with no receipt: the call may still land, so it is remembered, not forgotten.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await within(sheet).findByTestId("sheet-problem");
    chain.holdReceipts = false;
    await waitFor(() =>
      expect(within(sheet).getByTestId("sheet-confirm").textContent).toBe(
        "Look for your withdrawal",
      ),
    );
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("withdraw-sheet")).toBeNull(),
    );
    expect(chain.sent.length).toBe(1);
  }, 20_000);

  it("Escape closes a sheet and focus goes back to the button that opened it", async () => {
    setup(FOUNDER_EVM);
    show();
    const opener = await screen.findByTestId("seat-wind-down");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("wind-down-sheet");
    fireEvent.keyDown(screen.getByTestId("wind-down-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("wind-down-sheet")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
