// The sheets that offer the seat and wind the project down: what each says before the press, that the call is exactly what the
// sheet said, what a pair's signer sends (a proposal the other signer confirms), and who may see the founder's own choice to
// leave. Winding down says what it does to backers before the press and takes two presses.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
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
  aloneNumbers,
  ANNA,
  CARL_EVM,
  MEMBERS,
  nameOf,
  PAIR_OF_ANNA,
  pairNumbers,
  RUNNING_PAIR,
  type SeatChain,
  seatAnswers,
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
const choose = (pubkey: string) =>
  fireEvent.change(screen.getByTestId("offer-member"), {
    target: { value: pubkey },
  });
const DORA = MEMBERS[3]?.pubkey ?? "";
const ANNA_KEY = MEMBERS[1]?.pubkey ?? "";
const CARL_KEY = MEMBERS[2]?.pubkey ?? "";

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("hand over the seat", () => {
  it("lists the team without the one who runs it, a member with no wallet cannot be chosen, and nothing is sent by looking", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    const select = (await screen.findByTestId(
      "offer-member",
    )) as HTMLSelectElement;
    const options = [...select.options].map((o) => [o.textContent, o.disabled]);
    expect(options).toEqual([
      ["Choose someone on the team", false],
      ["Anna", false],
      ["Carl (has not linked an account)", true],
      ["Dora", false],
    ]);
    expect(screen.getByLabelText("Hand it to")).toBe(select);
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("says what happens before the press, and sends exactly the person chosen", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    await screen.findByTestId("offer-member");
    choose(ANNA_KEY);
    const terms = (await screen.findByTestId("offer-terms")).textContent ?? "";
    expect(terms).toContain(`Anna (${ANNA}) can take the seat`);
    expect(terms).toMatch(
      /Until they take it you still run the project's money, and you can withdraw the offer\./,
    );
    expect(terms).toMatch(
      /can no longer draw the allowance, change the rules, grant Team Shares or wind the project down/,
    );
    await waitFor(() =>
      expect(screen.getByTestId("offer-lasts").textContent).toBe(
        "The offer lasts about 56 minutes. If it is not taken, nothing changes and you can offer again.",
      ),
    );
    expect(screen.getByTestId("sheet-confirm").textContent).toBe(
      "Offer the seat to Anna",
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(chain.sent[0]?.to).toBe(alone.contracts.treasury);
    expect(call?.name).toBe("handOver");
    expect(call?.args).toEqual([ANNA, false]);
  });

  it("the founder can say they are leaving, and the call carries it; a runner who is not the founder is not asked", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    await screen.findByTestId("offer-member");
    choose(DORA);
    expect(
      screen.getByTestId("offer-leaves").parentElement?.textContent,
    ).toMatch(
      /I give up the part of my own Team Shares that has not unlocked yet\. What I have already built up stays mine\./,
    );
    fireEvent.click(screen.getByTestId("offer-leaves"));
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.args).toEqual([CARL_EVM, true]);
    cleanup();
    // Anna runs it (the seat was handed to her), and she is not the founder.
    const annaRuns = {
      ...alone,
      runner: { address: ANNA, isPair: false, signers: null },
    };
    setup(ANNA, {}, annaRuns);
    show(annaRuns);
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    await screen.findByTestId("offer-member");
    choose(MEMBERS[0]?.pubkey ?? "");
    expect(screen.queryByTestId("offer-leaves")).toBeNull();
  });

  it("a refusal on the chain is said in words and the same press tries again", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    await screen.findByTestId("offer-member");
    choose(ANNA_KEY);
    await screen.findByTestId("offer-terms");
    chain.refuse = "execution reverted: NotAllowed()";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).not.toMatch(/NotAllowed|0x/);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
  });

  it("one of a pair proposes it, and says the other signer must confirm the same step", async () => {
    const numbers = pairNumbers();
    setup(FOUNDER_EVM, {}, numbers);
    show(numbers);
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    await screen.findByTestId("offer-member");
    // Neither signer can be chosen: the founder and Anna already run it.
    const names = [
      ...(screen.getByTestId("offer-member") as HTMLSelectElement).options,
    ].map((o) => o.textContent);
    expect(names).toEqual([
      "Choose someone on the team",
      "Carl (has not linked an account)",
      "Dora",
    ]);
    choose(DORA);
    await screen.findByTestId("offer-terms");
    expect(screen.getByTestId("offer-sheet").textContent).toMatch(
      /This project is run by two\. Pressing asks the other signer: nothing happens until they confirm the same step\./,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const proposal = decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "");
    expect(chain.sent[0]?.to).toBe(RUNNING_PAIR);
    expect(proposal?.name).toBe("propose");
    expect(proposal?.args[0]).toBe(numbers.contracts.treasury);
    const inner = decodeCall(TREASURY_ABI, String(proposal?.args[1]));
    expect(inner?.name).toBe("handOver");
    expect(inner?.args).toEqual([CARL_EVM, false]);
  });
});

describe("run it together (make a pair)", () => {
  it("names the second signer, says what both signers means, and sends the pair address the Launcher gave", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-pair"));
    await screen.findByTestId("offer-member");
    expect(screen.getByLabelText("Who runs it with you?")).not.toBeNull();
    // No "leaving" choice here: the founder stays.
    choose(ANNA_KEY);
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByTestId("offer-leaves")).toBeNull();
    const terms = screen.getByTestId("offer-terms").textContent ?? "";
    expect(terms).toContain(`Anna (${ANNA}) can accept the second seat`);
    expect(terms).toMatch(
      /Until then you still run the project's money alone\./,
    );
    expect(terms).toMatch(
      /Running it together means both of you must agree to every step that moves money or changes a rule/,
    );
    expect(screen.getByTestId("sheet-confirm").textContent).toBe(
      "Ask Anna to run it with you",
    );
    // The address was asked of the Launcher for exactly this runner and this person.
    const asked = chain.reads.filter((r) => r.name === "pairAddress").at(-1);
    expect(asked?.args).toEqual([alone.key, FOUNDER_EVM, ANNA]);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(chain.sent[0]?.to).toBe(alone.contracts.treasury);
    expect(call?.name).toBe("handOver");
    expect(call?.args).toEqual([PAIR_OF_ANNA, false]);
  });

  it("when the pair's address cannot be worked out nothing can be sent, and it says so", async () => {
    setup(FOUNDER_EVM);
    chain.answers.pairAddress = () => {
      throw { code: -32603, message: "network down" };
    };
    show();
    fireEvent.click(await screen.findByTestId("seat-pair"));
    await screen.findByTestId("offer-member");
    choose(ANNA_KEY);
    expect(
      (await screen.findByTestId("offer-read-failed")).textContent,
    ).toMatch(
      /could not work out the address for the two of you, so nothing can be sent now/,
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("a member with no linked wallet cannot be asked", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-pair"));
    await screen.findByTestId("offer-member");
    choose(CARL_KEY);
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("offer-terms")).toBeNull();
  });
});

describe("wind down", () => {
  it("says what it does to backers before the press: taking out stays open, then it takes two presses and sends the Launcher's call for this project", async () => {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("seat-wind-down"));
    const sheet = await screen.findByTestId("wind-down-sheet");
    const lines = [
      ...within(sheet).getByTestId("wind-down-terms").querySelectorAll("li"),
    ].map((li) => li.textContent);
    expect(lines[0]).toMatch(
      /^Taking out stays open\. Everyone who holds Shares can still take their money out, with no fee and no wait/,
    );
    expect(lines).toContain("Winding down is for good. It cannot be undone.");
    expect(lines.join(" ")).toMatch(
      /Nobody can back the project any more, and the allowance stops/,
    );
    expect(lines.join(" ")).toMatch(
      /What each member has built up so far stays theirs/,
    );
    expect(within(sheet).getByTestId("sheet-confirm").textContent).toBe(
      "Wind down Lantern for good",
    );
    expect(chain.sent).toEqual([]);
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(LAUNCHER_ABI, chain.sent[0]?.data ?? "");
    expect(chain.sent[0]?.to).toBe(alone.launcher);
    expect(call?.name).toBe("windDown");
    expect(call?.args).toEqual([alone.key]);
  });

  it("one of a pair proposes it through the Pair and says the other signer must confirm", async () => {
    const numbers = pairNumbers();
    setup(ANNA, {}, numbers);
    show(numbers);
    fireEvent.click(await screen.findByTestId("seat-wind-down"));
    const sheet = await screen.findByTestId("wind-down-sheet");
    expect(sheet.textContent).toMatch(
      /This project is run by two\. Pressing asks the other signer/,
    );
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const proposal = decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "");
    expect(chain.sent[0]?.to).toBe(RUNNING_PAIR);
    expect(proposal?.args[0]).toBe(numbers.launcher);
    expect(decodeCall(LAUNCHER_ABI, String(proposal?.args[1]))?.args).toEqual([
      numbers.key,
    ]);
  });

  it("after half a year of quiet anyone may wind it down, with the Treasury's own call and the quiet words", async () => {
    setup(CARL_EVM);
    const late = alone.quiet.windableFrom ?? 0;
    show(alone, late + 10);
    expect((await screen.findByTestId("seat-quiet")).textContent).toMatch(
      /quiet for about half a year, so anyone can wind the project down\. Taking out stays open\./,
    );
    fireEvent.click(screen.getByTestId("seat-wind-down"));
    const sheet = await screen.findByTestId("wind-down-sheet");
    expect(within(sheet).getByTestId("wind-down-why").textContent).toMatch(
      /The team has not checked in since .* anyone can wind the project down\./,
    );
    expect(sheet.textContent).toMatch(
      /What has unlocked stays with its member/,
    );
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(chain.sent[0]?.to).toBe(alone.contracts.treasury);
    expect(call?.name).toBe("windDown");
  });

  it("is not offered to a stranger while the team is still checking in", async () => {
    setup(CARL_EVM);
    show();
    await waitFor(() => expect(chain.reads.length).toBeGreaterThan(5));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("seat-wind-down")).toBeNull();
  });
});

describe("assistive semantics", () => {
  it("every box has a label, every dialog a name, and no serious violation on any sheet", async () => {
    setup(FOUNDER_EVM, {});
    show();
    for (const [open, name] of [
      ["seat-hand-over", /Hand over the seat/],
      ["seat-pair", /Run it together/],
      ["seat-wind-down", /Wind down Lantern/],
    ] as const) {
      fireEvent.click(await screen.findByTestId(open));
      await screen.findByRole("dialog", { name });
      expect(await seriousViolations(), open).toEqual([]);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    // And the page part, with the runner's buttons.
    expect(await seriousViolations()).toEqual([]);
  });
});

describe("what is signed is what the sheet says", () => {
  it("offers the seat to the person the sheet names when the wallet is asked, even if the choice is tried again meanwhile", async () => {
    setup(FOUNDER_EVM, {});
    // The wallet holds the signature prompt open until the test lets it go (a person reading it).
    const eth = (
      window as unknown as {
        ethereum: { request: (a: unknown) => Promise<unknown> };
      }
    ).ethereum;
    const real = eth.request.bind(eth);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    eth.request = async (a: unknown) => {
      if ((a as { method: string }).method === "eth_sendTransaction")
        await gate;
      return real(a);
    };
    show();
    fireEvent.click(await screen.findByTestId("seat-hand-over"));
    await screen.findByTestId("offer-member");
    choose(MEMBERS[1]?.pubkey ?? "");
    await screen.findByTestId("offer-terms");
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const shown = screen.getByTestId("offer-terms").textContent ?? "";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    // The choice is shut while the press runs.
    expect(screen.getByTestId("offer-member").matches(":disabled")).toBe(true);
    release();
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    const named = MEMBERS[1]?.address ?? "";
    expect(shown.toLowerCase()).toContain(named.toLowerCase());
    expect(String(call?.args[0]).toLowerCase()).toBe(named.toLowerCase());
  });
});

describe("how long is quiet", () => {
  it("is this project's own wait: about 12 hours on a test network's 28-minute unit, never 'half a year'", async () => {
    const short = { ...alone, unit: 1680 };
    setup(CARL_EVM, {}, short);
    const late = short.quiet.windableFrom ?? 0;
    show(short, late + 10);
    const words = (await screen.findByTestId("seat-quiet")).textContent ?? "";
    expect(words).toMatch(/quiet for about 12 hours, so anyone can wind/);
    expect(words).not.toMatch(/half a year/);
  });
});
