// The Back sheet and its box: the numbers shown are the numbers put into the call, one signature on a dollar that can pay and
// call and two on one that cannot, and every state that stops a Back says what to do instead.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { faucetCall } from "@creaton/core/pot/pot-calls.ts";
import {
  PLAY_DOLLAR_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { decodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
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
  backerAnswers,
  D,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { forgetPending, sendKey } from "../money/pending-sends";
import { BackCard } from "./BackCard";
import { ownSteps } from "./own-history";

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

const numbers = numbersFor();
const NOW = numbers.builtAt + 100;
let chain: PotChain;

function setup(
  options: { payAndCall?: boolean; answers?: Record<string, unknown> } = {},
) {
  chain = installPotChain({
    account: BACKER_EVM,
    payAndCall: options.payAndCall,
    answers: { ...backerAnswers(numbers), ...options.answers } as never,
  });
}

/** The Back box with `amount` typed and Back pressed: the sheet opens. */
async function openSheet(amount = "10") {
  wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
  const field = await screen.findByLabelText("How many dollars?");
  fireEvent.change(field, { target: { value: amount } });
  fireEvent.click(screen.getByTestId("backing-review"));
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  forgetPending(
    sendKey(
      `back:${numbers.chainId}:${numbers.contracts.treasury}`,
      BACKER_EVM,
    ),
  );
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the Back sheet shows what is put into the call", () => {
  it("shows what you pay, the fee, the Shares and what taking out now gives, and sends one signature with that guard", async () => {
    setup();
    await openSheet("10");
    expect((await screen.findByTestId("back-pay")).textContent).toBe(
      "10 dollars",
    );
    expect(screen.getByTestId("back-shares").textContent).toBe("1,000 Shares");
    expect(screen.getByTestId("back-now").textContent).toBe("9.80 dollars");
    expect(screen.getByTestId("back-fee").textContent).toBe(
      "Creaton keeps 2% of what you pay.",
    );
    expect(
      screen.getByText(/This can go up or down. It is not a return./),
    ).not.toBeNull();
    expect(screen.getByTestId("sheet-play-money")).not.toBeNull();
    // Nothing to tick: Back is one press, and it makes nothing public.
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    // One signature: a single transferAndCall to the Treasury, with the amount shown and a guard 0.5% under the quote.
    const call = chain.sent[0];
    expect(call.to).toBe(numbers.contracts.dollar);
    const decoded = decodeCall(PLAY_DOLLAR_ABI, call.data);
    expect(decoded?.name).toBe("transferAndCall");
    expect(decoded?.args[0]).toBe(numbers.contracts.treasury);
    expect(decoded?.args[1]).toBe(10n * D);
    const [minShares, to] = decodeParameters(
      ["uint256", "address"],
      decoded?.args[2] as string,
    );
    expect(minShares).toBe((1_000n * S * 9_950n) / 10_000n);
    // In one call the Shares go to whoever pays: the zero address says so, and no account is named that could differ.
    expect(String(to)).toBe(`0x${"0".repeat(40)}`);
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
  });

  it("says the contracts are unaudited before the press, on every money sheet", async () => {
    // The line lives in the one sheet every money press goes through (`PotSheet`), so it cannot be left off one of them.
    setup();
    await openSheet();
    expect(screen.getByTestId("sheet-unaudited").textContent).toBe(
      "The contracts behind these screens are new and have not been audited.",
    );
  });

  it("with a dollar that cannot pay and call, it is approve then join, and says so", async () => {
    setup({ payAndCall: false });
    await openSheet("25.50");
    await screen.findByTestId("back-pay");
    expect(screen.getByTestId("back-pay").textContent).toBe("25.50 dollars");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
    const [approve, join] = chain.sent;
    const a = decodeCall(PLAY_DOLLAR_ABI, approve.data);
    expect(a?.name).toBe("approve");
    expect(a?.args[1]).toBe(25_500_000n);
    const j = decodeCall(TREASURY_ABI, join.data);
    expect(j?.name).toBe("join");
    expect(j?.args[0]).toBe(25_500_000n);
    expect(j?.args[2]).toBe(BACKER_EVM);
  });

  it("reads the chain when it opens: the quote is asked for exactly the amount typed", async () => {
    setup();
    await openSheet("7");
    await screen.findByTestId("back-pay");
    const quotes = chain.reads.filter((r) => r.name === "quoteBack");
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((q) => q.args[0] === 7n * D)).toBe(true);
  });
});

describe("what stops a Back says what to do", () => {
  it("an amount under the smallest says what the smallest is, and sends nothing", async () => {
    setup();
    await openSheet("0.5");
    expect(
      await screen.findByText(/The smallest amount is 1 dollar\./),
    ).not.toBeNull();
    expect(screen.queryByTestId("back-sheet")).toBeNull();
    expect(chain.sent).toEqual([]);
  });

  it("an amount that is not a number says how to write one", async () => {
    setup();
    await openSheet("ten");
    expect(await screen.findByText(/Write a number, like 25/)).not.toBeNull();
  });

  it("a door the record says is shut shows no form and says why; taking out is pointed to", async () => {
    setup();
    const shut = numbersFor((c) => {
      (c.door as Record<string, unknown>).switchOn = false;
      (c.door as Record<string, unknown>).openNow = false;
    });
    wrap(<BackCard now={NOW} numbers={shut} projectName="Lantern" />);
    const words = await screen.findByTestId("back-door-shut");
    expect(words.textContent).toMatch(/closed the door to new backing/);
    expect(screen.queryByTestId("backing-amount")).toBeNull();
  });

  it("a door the chain says is shut (the record was old) stops the press and says what to do", async () => {
    setup({ answers: { doorOpenNow: [false] } });
    await openSheet("10");
    const words = await screen.findByTestId("back-door-shut");
    expect(words.textContent).toMatch(/shut right now/);
    expect(
      within(screen.getByTestId("back-sheet")).queryByTestId("sheet-confirm"),
    ).not.toBeNull();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("an amount that buys no Shares says so", async () => {
    setup({ answers: { quoteBack: [0n, 0n, 0n, 0n] } });
    await openSheet("1");
    const words = await screen.findByTestId("back-no-shares");
    expect(words.textContent).toMatch(/too small to buy any Shares/);
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("too few play dollars says how many are held and sends nothing", async () => {
    setup({ answers: backerAnswers(numbers, { dollars: 3n * D }) });
    await openSheet("10");
    const words = await screen.findByTestId("back-short");
    expect(words.textContent).toMatch(/hold 3 play dollars/);
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("too few play dollars puts the way to get them in the sheet, and the press sends the faucet call", async () => {
    setup({ answers: backerAnswers(numbers, { dollars: 0n }) });
    await openSheet("10");
    await screen.findByTestId("back-short");
    const sheet = screen.getByTestId("back-sheet");
    fireEvent.click(await within(sheet).findByTestId("faucet-open"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].data).toBe(faucetCall(numbers.contracts.dollar).data);
  });

  it("a price that could not be read says nothing was taken and offers to try again", async () => {
    setup({
      answers: {
        quoteBack: () => {
          throw new Error("rate limited");
        },
      },
    });
    await openSheet("10");
    const failed = await screen.findByTestId("back-read-failed");
    expect(failed.textContent).toMatch(/nothing was taken/);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  });
});

describe("a press is sent once, and a failure leaves a way to try again", () => {
  it("a double press sends one call", async () => {
    setup();
    chain.holdReceipts = true;
    await openSheet("10");
    await screen.findByTestId("back-pay");
    const confirm = screen.getByTestId("sheet-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(chain.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent.length).toBe(1);
  });

  it("a refusal from the chain is said in plain words, nothing is recorded, and pressing again tries again", async () => {
    setup();
    await openSheet("10");
    await screen.findByTestId("back-pay");
    chain.refuse = "execution reverted: DoorShut()";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(/not taking new backers right now/);
    expect(problem.textContent).not.toMatch(/DoorShut/);
    expect(chain.sent).toEqual([]);
    // The press is still there, and a second press sends.
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
  });

  it("a send that went out but has not landed is looked up, not sent again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    chain.holdReceipts = true;
    await openSheet("10");
    await screen.findByTestId("back-pay");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    // The wallet's wait runs out with no receipt: the call may still land, so it is remembered, not forgotten.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    chain.holdReceipts = false;
    await waitFor(() =>
      expect(screen.getByTestId("sheet-confirm").textContent).toMatch(
        /Look for your backing/,
      ),
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    // It was looked up, not sent a second time.
    expect(chain.sent.length).toBe(1);
  }, 20_000);

  it("Escape closes the sheet and focus goes back to the Back button", async () => {
    setup();
    await openSheet("10");
    await screen.findByTestId("back-pay");
    fireEvent.keyDown(screen.getByTestId("back-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    expect(chain.sent).toEqual([]);
  });

  it("refuses to send when the wallet now shows another account than the one the numbers were read for", async () => {
    setup();
    await openSheet("10");
    await screen.findByTestId("back-pay");
    chain.account = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(
      /different account than the one these numbers were read for/,
    );
    expect(problem.textContent).toMatch(/Nothing was sent/);
    expect(chain.sent).toEqual([]);
  });

  it("says so when an earlier press of this step has not been found yet, and looks for it instead of sending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    chain.holdReceipts = true;
    await openSheet("10");
    await screen.findByTestId("back-pay");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    // The person closes the sheet and asks for another amount: the earlier one is looked up first.
    fireEvent.keyDown(screen.getByTestId("back-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    chain.holdReceipts = false;
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("backing-review"));
    await screen.findByTestId("back-pay");
    expect(
      (await screen.findByTestId("sheet-earlier-waiting")).textContent,
    ).toMatch(/nothing new is sent while it may still land/);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    expect(chain.sent.length).toBe(1);
    // The earlier press was not written down as the 25 dollars on this sheet.
    expect(ownSteps(BACKER_EVM)).toEqual([]);
  }, 20_000);

  it("focus returns to the Back button when the sheet closes", async () => {
    setup();
    wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
    fireEvent.change(await screen.findByLabelText("How many dollars?"), {
      target: { value: "10" },
    });
    const button = screen.getByTestId("backing-review");
    button.focus();
    fireEvent.click(button);
    await screen.findByTestId("back-pay");
    fireEvent.keyDown(screen.getByTestId("back-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("the sheet names its controls: the amount field has a label and the press has words", async () => {
    setup();
    await openSheet("10");
    await screen.findByTestId("back-pay");
    expect(
      screen.getByRole("button", { name: /Back with 10 dollars/ }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).not.toBeNull();
    expect(screen.getByLabelText("How many dollars?")).not.toBeNull();
  });
});

describe("before there is a wallet", () => {
  it("with no wallet in the browser it says to open the page in one", async () => {
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
    expect((await screen.findByTestId("pot-no-wallet")).textContent).toMatch(
      /browser with a wallet/,
    );
  });

  it("a build that names no network offers no press and says so", async () => {
    setup();
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_CREATON_CHAIN_ID", "");
    wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
    expect((await screen.findByTestId("pot-build-words")).textContent).toMatch(
      /not switched on/,
    );
  });
});

describe("what the sheet says is what the call takes", () => {
  it("shows every decimal of a typed amount (to six) in the pay line, the press and the call: nothing is rounded down", async () => {
    setup();
    await openSheet("25.123456");
    expect((await screen.findByTestId("back-pay")).textContent).toBe(
      "25.123456 dollars",
    );
    expect(screen.getByTestId("sheet-confirm").textContent).toBe(
      "Back with 25.123456 dollars",
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(PLAY_DOLLAR_ABI, chain.sent[0].data);
    expect(decoded?.args[1]).toBe(25_123_456n);
  });

  it("does not show 10.005 as 10", async () => {
    setup();
    await openSheet("10.005");
    expect((await screen.findByTestId("back-pay")).textContent).toBe(
      "10.005 dollars",
    );
  });

  it("shows what the chain quotes now, not the record's hours-old fee: the Shares and what taking out would give", async () => {
    // The record says 2%; the chain charges 5% now.
    setup({
      answers: {
        feeFor: (args: readonly unknown[]) => [
          ((args[0] as bigint) * 5n) / 100n,
        ],
        quoteBack: (args: readonly unknown[]) => {
          const amount = args[0] as bigint;
          return [(amount * 100n * S) / D, (amount * 95n) / 100n, 0n, 0n];
        },
      },
    });
    await openSheet("10");
    expect(
      await screen.findByTestId("back-now").then((e) => e.textContent),
    ).toBe("9.50 dollars");
    expect(screen.getByTestId("back-fee").textContent).toBe(
      "Creaton keeps 5% of what you pay.",
    );
  });

  it("says nothing of a fee when the platform keeps none", async () => {
    setup({
      answers: {
        feeFor: () => [0n],
        quoteBack: (args: readonly unknown[]) => {
          const amount = args[0] as bigint;
          return [(amount * 100n * S) / D, amount, 0n, 0n];
        },
      },
    });
    await openSheet("10");
    await screen.findByTestId("back-pay");
    expect(screen.queryByTestId("back-fee")).toBeNull();
  });
});

describe("play money is said whatever the record says", () => {
  it("the Back sheet says it when the record says playMoney false", async () => {
    const odd = numbersFor((content) => {
      content.playMoney = false;
    });
    expect(odd.playMoney).toBe(false);
    nameTheNetwork(odd);
    chain = installPotChain({
      account: BACKER_EVM,
      answers: backerAnswers(odd) as never,
    });
    wrap(<BackCard now={NOW} numbers={odd} projectName="Lantern" />);
    fireEvent.change(await screen.findByLabelText("How many dollars?"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("backing-review"));
    await screen.findByTestId("back-pay");
    expect(screen.getByTestId("sheet-play-money").textContent).toMatch(
      /play money/,
    );
  });
});

describe("a record that names contracts this build does not know is not sent money from", () => {
  it("shows no Back box when the record's Launcher is not the build's", async () => {
    setup();
    // The build was made for a newer deployment; the server still serves the old one.
    vi.stubEnv("VITE_CREATON_LAUNCHER", `0x${"7".repeat(40)}`);
    wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
    expect(
      (await screen.findByTestId("back-wrong-contracts")).textContent,
    ).toMatch(/does not know/);
    expect(screen.queryByTestId("backing-amount")).toBeNull();
    expect(chain.sent).toEqual([]);
  });

  it("shows no Back box when the record's dollar is not the build's", async () => {
    setup();
    vi.stubEnv("VITE_CREATON_DOLLAR", `0x${"8".repeat(40)}`);
    wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
    expect(await screen.findByTestId("back-wrong-contracts")).not.toBeNull();
    expect(screen.queryByTestId("backing-amount")).toBeNull();
  });
});

describe("a wallet that never answers does not lock the sheet", () => {
  it("Escape closes it while the press is waiting", async () => {
    setup();
    const real = (
      window as unknown as {
        ethereum: { request: (a: { method: string }) => Promise<unknown> };
      }
    ).ethereum;
    const request = real.request.bind(real);
    real.request = (args) =>
      args.method === "eth_sendTransaction"
        ? new Promise(() => undefined)
        : request(args);
    await openSheet();
    await screen.findByTestId("back-pay");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("sheet-confirm").textContent).toMatch(
        /Waiting/,
      ),
    );
    fireEvent.keyDown(screen.getByTestId("back-sheet"), {
      key: "Escape",
      code: "Escape",
    });
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
  });
});

describe("what arrives after the sheet opened is announced", () => {
  it("holds the quote in a polite live region", async () => {
    setup();
    await openSheet();
    const pay = await screen.findByTestId("back-pay");
    expect(pay.closest("[aria-live='polite']")).not.toBeNull();
  });
});
