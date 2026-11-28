// What you hold, in the top of the page, and the Take out sheet: what is held and what taking out gives are read from the
// chain, the call carries the number shown and a guard from the same quote, the press is open whatever state the door or the
// project is in, and a person with zero Shares is offered no press.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
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
  backerAnswers,
  D,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { ownSteps } from "./own-history";
import { targetOf } from "./target";
import { HoldingTop } from "./HoldingTop";
import { YourShares } from "./YourShares";

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
const target = targetOf(numbers);
let chain: PotChain;

function setup(
  held: { shares?: bigint; team?: bigint; dollars?: bigint },
  extra: Record<string, unknown> = {},
) {
  chain = installPotChain({
    account: BACKER_EVM,
    answers: { ...backerAnswers(numbers, held), ...extra } as never,
  });
}
const holdingTop = (t = target) => (
  <HoldingTop
    onOpenMoney={() => {}}
    projectName="Lantern"
    target={t}
    tasks={null}
  />
);
/** The top of the page (what you hold and Take out) with the Money tab's card below it. */
const show = () =>
  wrap(
    <>
      {holdingTop()}
      <YourShares projectName="Lantern" target={target} />
    </>,
  );

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

describe("Your Shares", () => {
  it("with zero Shares draws no Take out and no line about Shares", async () => {
    setup({ shares: 0n });
    show();
    expect((await screen.findByTestId("holding-dollars")).textContent).toBe(
      "1,000",
    );
    expect(screen.queryByTestId("holding-take-out")).toBeNull();
    expect(screen.queryByTestId("top-holding")).toBeNull();
  });

  it("shows what you hold and what taking out gives now, from the chain", async () => {
    setup({ shares: 1_020n * S });
    show();
    expect((await screen.findByTestId("holding-shares")).textContent).toBe(
      "1,020 Shares",
    );
    expect(screen.getByTestId("holding-cash").textContent).toBe("9.99 dollars");
    expect(
      screen.getByText(/This can go up or down. It is not a return./),
    ).not.toBeNull();
    const quote = chain.reads.find((r) => r.name === "quoteTakeOut");
    expect(quote?.args).toEqual([BACKER_EVM, 1_020n * S]);
  });
});

describe("the Take out sheet", () => {
  it("shows the cash now and what is kept, and sends the number shown with a guard 0.5% under the quote", async () => {
    setup({ shares: 1_000n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    expect((await screen.findByTestId("takeout-cash")).textContent).toBe(
      "9.80 dollars",
    );
    expect(screen.getByTestId("takeout-held").textContent).toBe("1,000 Shares");
    expect(screen.getByTestId("takeout-shares").textContent).toBe(
      "1,000 Shares",
    );
    expect(screen.getByTestId("takeout-kept").textContent).toBe("0 Shares");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = chain.sent[0];
    expect(call.to).toBe(numbers.contracts.treasury);
    const decoded = decodeCall(TREASURY_ABI, call.data);
    expect(decoded?.name).toBe("leave");
    expect(decoded?.args[0]).toBe(1_000n * S);
    // 9.80 dollars is the quote; the guard is 0.5% under it, read from that same quote.
    expect(decoded?.args[1]).toBe((9_800_000n * 9_950n) / 10_000n);
    expect(decoded?.args[2]).toBe(BACKER_EVM);
    await waitFor(() =>
      expect(screen.queryByTestId("takeout-sheet")).toBeNull(),
    );
    // The step is in this account's own history.
    expect(ownSteps(BACKER_EVM, numbers.key)[0]?.kind).toBe("take-out");
  });

  it("taking out half sends half of what is held, and shows what is kept", async () => {
    setup({ shares: 1_000n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.click(screen.getByTestId("takeout-portion-half"));
    await waitFor(() =>
      expect(screen.getByTestId("takeout-shares").textContent).toBe(
        "500 Shares",
      ),
    );
    expect(screen.getByTestId("takeout-cash").textContent).toBe("4.90 dollars");
    expect(screen.getByTestId("takeout-kept").textContent).toBe("500 Shares");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(decodeCall(TREASURY_ABI, chain.sent[0].data)?.args[0]).toBe(
      500n * S,
    );
  });

  it("says that outside money still arriving is not paid now", async () => {
    setup({ shares: 1_000n * S }, { quoteTakeOut: [9_800_000n, 0n, 4n * D] });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    const words = await screen.findByTestId("takeout-arriving");
    expect(words.textContent).toMatch(
      /4 dollars of outside money is still arriving/,
    );
    expect(words.textContent).toMatch(/leaves it for the people who stay/);
  });

  it("a refused press says what happened and leaves the press to try again", async () => {
    setup({ shares: 1_000n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    chain.refuse = "execution reverted: TooLittleCash(1,2)";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).not.toMatch(/TooLittleCash/);
    expect(chain.sent).toEqual([]);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
  });

  it("when what it gives could not be read it says nothing was taken", async () => {
    // The page's own read of the holding answers; the sheet's read, a moment later, does not.
    let asked = 0;
    setup(
      { shares: 1_000n * S },
      {
        quoteTakeOut: () => {
          asked += 1;
          if (asked > 1) throw new Error("node down");
          return [9_800_000n, 0n, 0n];
        },
      },
    );
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    expect(
      (await screen.findByTestId("takeout-read-failed")).textContent,
    ).toMatch(/Nothing was taken/);
  });

  it("Escape closes it and nothing is sent", async () => {
    setup({ shares: 1_000n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.keyDown(screen.getByTestId("takeout-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("takeout-sheet")).toBeNull(),
    );
    expect(chain.sent).toEqual([]);
  });
});

describe("Team Shares held", () => {
  it("say plainly that they pay only above what backers put in, and the take-out says it is an estimate", async () => {
    setup({ shares: 0n, team: 2_000n * S }, { teamValue: [61n] });
    show();
    const words = await screen.findByTestId("holding-team-words");
    expect(words.textContent).toMatch(
      /pay only the project's money above what backers put in/,
    );
    fireEvent.click(screen.getByTestId("holding-take-out-team"));
    expect(
      (await screen.findByTestId("takeout-team-words")).textContent,
    ).toMatch(/estimate/);
    // 2,000 Team Shares at 61 millionths of a dollar each.
    expect(screen.getByTestId("takeout-cash").textContent).toBe(
      "0.122 dollars",
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(TREASURY_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("leaveTeam");
    expect(decoded?.args[0]).toBe(2_000n * S);
    // The guard is 2% under the estimate (122,000 raw units), never zero.
    expect(decoded?.args[1]).toBe((122_000n * 9_800n) / 10_000n);
  });

  it("worth nothing says so and offers no press", async () => {
    setup({ shares: 0n, team: 2_000n * S }, { teamValue: [0n] });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out-team"));
    expect((await screen.findByTestId("takeout-nothing")).textContent).toMatch(
      /nothing now/,
    );
  });
});

describe("leaving does not depend on a nicety", () => {
  it("Take out is still offered when only the play-dollar balance cannot be read", async () => {
    const { dollar, shares } = numbers.contracts;
    setup(
      { shares: 1_000n * S },
      {
        balanceOf: (_args: readonly unknown[], to: string) => {
          if (to === dollar) throw new Error("execution reverted");
          return to === shares ? [1_000n * S] : [0n];
        },
      },
    );
    show();
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
    expect(screen.getByTestId("holding-shares").textContent).toBe(
      "1,000 Shares",
    );
    expect(screen.queryByTestId("holding-dollars")).toBeNull();
    expect(screen.queryByTestId("holding-read-failed")).toBeNull();
  });

  it("Take out is still offered when only the quote of what it gives cannot be read; the sheet reads its own", async () => {
    let asked = 0;
    setup(
      { shares: 1_000n * S },
      {
        quoteTakeOut: () => {
          asked += 1;
          if (asked === 1) throw new Error("node hiccup");
          return [9_800_000n, 0n, 0n];
        },
      },
    );
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    expect((await screen.findByTestId("takeout-cash")).textContent).toBe(
      "9.80 dollars",
    );
  });

  it("a part that is too small to take out leaves the choice on the sheet, so 'all of it' is one press away", async () => {
    // Three wei of Shares: half is one wei, a quarter is none.
    setup({ shares: 3n }, { quoteTakeOut: [1n, 0n, 0n] });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-portion-quarter");
    fireEvent.click(screen.getByTestId("takeout-portion-quarter"));
    expect((await screen.findByTestId("takeout-tiny")).textContent).toMatch(
      /too small to take out/,
    );
    fireEvent.click(screen.getByTestId("takeout-portion-all"));
    expect(await screen.findByTestId("takeout-cash")).not.toBeNull();
  });
});

describe("play money is said on a take-out whatever the record says", () => {
  it("the Take out sheet says it when the record says playMoney false", async () => {
    const odd = numbersFor((content) => {
      content.playMoney = false;
    });
    chain = installPotChain({
      account: BACKER_EVM,
      answers: backerAnswers(odd, { shares: 1_000n * S }) as never,
    });
    wrap(holdingTop(targetOf(odd)));
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    expect(screen.getByTestId("sheet-play-money").textContent).toMatch(
      /play money/,
    );
  });
});

describe("the history says what was quoted, not what landed", () => {
  it("writes a take-out down as 'about' the quoted dollars: the price may have moved inside the guard", async () => {
    setup({ shares: 1_000n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    const { dollar, shares } = numbers.contracts;
    // The balances change when the call goes out, so the read that follows the landing sees them.
    chain.onSend = () => {
      chain.answers.balanceOf = (_args, to) =>
        to === dollar ? [1_009_770_000n] : to === shares ? [0n] : [0n];
    };
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const step = await screen.findByTestId("history-step", undefined, {
      timeout: 3000,
    });
    expect(step.textContent).toMatch(/got about 9\.80 dollars/);
    expect(step.textContent).not.toMatch(/got 9\.80 dollars/);
  });
});
