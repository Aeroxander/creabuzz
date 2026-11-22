// A holder's presses about the pause on Your Shares: Park Shares (a wallet asks twice, a passkey account once), Take back
// (inline, no sheet), and a Take out of Shares that are partly or wholly parked (unpark first, then leave, in the one press).
// The chain here is a stand-in that moves Shares between the wallet and the pause when the calls it is sent say so.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  HOLDER_PAUSE_ABI,
  SHARE_TOKEN_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  numbersWithPause,
  PAUSE,
  pauseAnswers,
} from "../../../tests/helpers/pause-harness";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  S,
} from "../../../tests/helpers/pot-harness";
import { createPasskeySender } from "../money/passkey-sender";
import { forgetSendTargets } from "../money/send-targets";
import { injectedWallet } from "../money/wallet";
import { YourShares } from "../pot/YourShares";
import { PauseCard } from "./PauseCard";
import type { PauseInfo } from "./PauseControls";
import { targetOf } from "../pot/target";

const holder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../money/sender", async (actual) => {
  const real = await actual<typeof import("../money/sender")>();
  return {
    ...real,
    useSender: (...args: unknown[]) =>
      holder.current ??
      (real.useSender as (...a: unknown[]) => unknown)(...args),
  };
});
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

const numbers = numbersWithPause({ parked: 0n });
const target = targetOf(numbers);
const BACKERS = BigInt(numbers.shares.backers);
let chain: PotChain;
/** Where each account's Shares are now. */
const world = { wallet: 0n, parked: 0n };

function install(
  start: { wallet: bigint; parked: bigint },
  options: { gate?: "named" | "none" | "other" | "fails" } = {},
) {
  world.wallet = start.wallet;
  world.parked = start.parked;
  const answers = {
    ...backerAnswers(numbers, {}),
    balanceOf: (_args: readonly unknown[], to: string) =>
      to === numbers.contracts.shares
        ? [world.wallet]
        : to === numbers.contracts.dollar
          ? [1_000_000_000n]
          : [0n],
    quoteTakeOut: (args: readonly unknown[]) => {
      const n = args[1] as bigint;
      return [(n * 9_800n) / S, 0n, 0n];
    },
    ...pauseAnswers({ mine: 0n, parked: 0n, backers: BACKERS }),
    parkedOf: () => [world.parked],
    state: () =>
      pauseAnswers({ mine: 0n, parked: world.parked, backers: BACKERS }).state,
    pauseGate: () => {
      if (options.gate === "fails")
        throw { code: -32603, message: "node down" };
      return [
        options.gate === "none"
          ? "0x0000000000000000000000000000000000000000"
          : options.gate === "other"
            ? `0x${"99".repeat(20)}`
            : PAUSE,
      ];
    },
  };
  chain = installPotChain({ account: BACKER_EVM, answers: answers as never });
  chain.onSend = (tx) => {
    const park = decodeCall(HOLDER_PAUSE_ABI, tx.data);
    if (park?.name === "park") {
      world.wallet -= park.args[0] as bigint;
      world.parked += park.args[0] as bigint;
    } else if (park?.name === "unpark") {
      world.wallet += park.args[0] as bigint;
      world.parked -= park.args[0] as bigint;
    } else {
      const leave = decodeCall(TREASURY_ABI, tx.data);
      if (leave?.name === "leave") world.wallet -= leave.args[0] as bigint;
    }
  };
}

const show = (
  pauseInfo: PauseInfo = {
    contract: numbers.contracts.pause ?? null,
    record: numbers.pause,
  },
) =>
  wrap(
    <YourShares pauseInfo={pauseInfo} projectName="Lantern" target={target} />,
  );

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  forgetSendTargets();
  holder.current = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

const names = () =>
  chain.sent.map((tx) => {
    const call =
      decodeCall(HOLDER_PAUSE_ABI, tx.data) ??
      decodeCall(TREASURY_ABI, tx.data) ??
      decodeCall(SHARE_TOKEN_ABI, tx.data);
    return [call?.name, tx.to, ...(call?.args ?? [])];
  });

describe("Park Shares", () => {
  it("is offered where the record names a pause and the person holds Shares, and nowhere else", async () => {
    install({ wallet: 1_000n * S, parked: 0n });
    show();
    expect(await screen.findByTestId("park-open")).toBeTruthy();
    cleanup();
    // an older record (no pause at all), and a person who holds nothing
    show({ contract: null, record: undefined as never });
    await screen.findByTestId("holding-shares");
    expect(screen.queryByTestId("park-open")).toBeNull();
    cleanup();
    install({ wallet: 0n, parked: 0n });
    show();
    await screen.findByTestId("holding-none");
    expect(screen.queryByTestId("park-open")).toBeNull();
  });

  it("a wallet is asked twice: approve to the pause, then park; the sheet says so and does not promise one press", async () => {
    install({ wallet: 1_000n * S, parked: 0n });
    show();
    fireEvent.click(await screen.findByTestId("park-open"));
    const first = await screen.findByTestId("park-first");
    expect(first.textContent).toBe(
      "Parked Shares count toward pausing the team's spending. They stay yours: take them back or take them out any day.",
    );
    expect(first.textContent).not.toMatch(/one press/);
    expect(screen.getByTestId("park-account-line").textContent).toBe(
      "Your wallet is asked twice: first to let the project hold them, then to park.",
    );
    expect((await screen.findByTestId("park-summary")).textContent).toMatch(
      /^You park 1,000 Shares\. After this, 0\.2% of backers' Shares are parked\. At a third, the team's allowance and new task plans pause one day later\.$|^You park 1,000 Shares\. After this, .* of backers' Shares are parked\. At a third, the team's allowance and new task plans pause one day later\.$/,
    );
    expect(screen.getByTestId("park-second").textContent).toBe(
      "Parking does not move your money. Parked Shares cannot be sent until you take them back.",
    );
    expect(screen.getByTestId("sheet-banner")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
    expect(names()).toEqual([
      ["approve", numbers.contracts.shares, PAUSE, 1_000n * S],
      ["park", PAUSE, 1_000n * S],
    ]);
    // Parked: the line says so and Take back is there
    expect(await screen.findByTestId("holding-parked")).toBeTruthy();
    expect(screen.getByTestId("holding-parked").textContent).toBe(
      "1,000 of your 1,000 Shares are parked.",
    );
    expect(screen.getByTestId("take-back")).toBeTruthy();
    // Everything is parked: nothing is left in the wallet to park, so only Take back is offered.
    expect(screen.queryByTestId("park-open")).toBeNull();
    expect(screen.getByTestId("holding-shares").textContent).toBe(
      "1,000 Shares",
    );
  });

  it("half parks half of the wallet's Shares, and the summary follows", async () => {
    install({ wallet: 1_000n * S, parked: 0n });
    show();
    fireEvent.click(await screen.findByTestId("park-open"));
    await screen.findByTestId("park-summary");
    fireEvent.click(screen.getByTestId("park-portion-half"));
    await waitFor(() =>
      expect(screen.getByTestId("park-summary").textContent).toMatch(
        /^You park 500 Shares\./,
      ),
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
    expect(names()[1]).toEqual(["park", PAUSE, 500n * S]);
  });

  it("a passkey account parks in one operation of two calls, with 'in one press' and 'asked once'", async () => {
    install({ wallet: 1_000n * S, parked: 0n });
    const sent: unknown[][] = [];
    const inner = injectedWallet();
    holder.current = createPasskeySender(
      {
        chainId: numbers.chainId,
        rpcUrl: "http://rpc.invalid",
        bundlerUrl: "http://bundler.invalid",
      },
      {
        probe: {
          credentialId: () => "cred",
          ownerKey: () => `04${"11".repeat(64)}`,
        },
        load: async () => ({
          connectedAddress: async () => BACKER_EVM,
          getAddress: async () => BACKER_EVM,
          readCall: (to, data) => inner.readCall(to, data),
          blockNumber: () => inner.blockNumber(),
          chainId: () => inner.chainId(),
          getLogs: (f) => inner.getLogs(f),
          outcomeOf: (s) => inner.outcomeOf(s),
          sendCalls: async (calls) => {
            sent.push([...calls]);
            return {
              hash: `0x${"ab".repeat(32)}`,
              status: "confirmed",
            } as never;
          },
        }),
      },
    );
    show();
    fireEvent.click(await screen.findByTestId("park-open"));
    expect((await screen.findByTestId("park-first")).textContent).toMatch(
      /take them out any day\. In one press\.$/,
    );
    expect(screen.getByTestId("park-account-line").textContent).toBe(
      "Your passkey is asked once.",
    );
    fireEvent.click(await screen.findByTestId("sheet-confirm"));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toHaveLength(2);
    const [approve, park] = sent[0] as { to: string; data: string }[];
    expect(decodeCall(SHARE_TOKEN_ABI, approve.data)?.name).toBe("approve");
    expect(decodeCall(HOLDER_PAUSE_ABI, park.data)?.name).toBe("park");
    expect(park.to).toBe(PAUSE);
  });

  it("a record that names a pause it could not read offers no park press and says why", async () => {
    install({ wallet: 1_000n * S, parked: 0n });
    show({ contract: numbers.contracts.pause ?? null, record: null });
    fireEvent.click(await screen.findByTestId("park-open"));
    expect((await screen.findByTestId("park-unreadable")).textContent).toMatch(
      /The stop could not be read right now, so nothing can be parked\./,
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent.length).toBe(0);
  });

  it("a pause the Treasury does not name the way the record does is never approved to", async () => {
    install({ wallet: 1_000n * S, parked: 0n }, { gate: "other" });
    show();
    fireEvent.click(await screen.findByTestId("park-open"));
    expect(await screen.findByTestId("park-unreadable")).toBeTruthy();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent.length).toBe(0);
  });

  it("Shares that moved after the sheet opened are not parked on the old numbers", async () => {
    install({ wallet: 1_000n * S, parked: 0n });
    show();
    fireEvent.click(await screen.findByTestId("park-open"));
    await screen.findByTestId("park-summary");
    world.wallet = 300n * S;
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /Your Shares changed since this was shown\. Nothing was sent\./,
    );
    expect(chain.sent.length).toBe(0);
  });
});

describe("Take back", () => {
  it("is inline: one press asks, the second sends unpark of what is parked; Cancel sends nothing", async () => {
    install({ wallet: 600n * S, parked: 400n * S });
    show();
    expect((await screen.findByTestId("holding-parked")).textContent).toBe(
      "400 of your 1,000 Shares are parked.",
    );
    fireEvent.click(screen.getByTestId("take-back"));
    expect(screen.getByTestId("take-back-ask").textContent).toMatch(
      /^Take back 400 Shares to your wallet\. Nothing is charged\./,
    );
    // no sheet of its own
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("take-back-cancel"));
    expect(chain.sent.length).toBe(0);
    // The place stays: Cancel removes the focused button, so focus goes back to the press that opened the ask.
    expect(document.activeElement).toBe(screen.getByTestId("take-back"));
    fireEvent.click(screen.getByTestId("take-back"));
    fireEvent.click(screen.getByTestId("take-back-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(names()).toEqual([["unpark", PAUSE, 400n * S]]);
    await waitFor(() =>
      expect(screen.queryByTestId("holding-parked")).toBeNull(),
    );
    // Nothing is parked now and the control is gone: the place is the card's heading, not the page.
    expect(document.activeElement?.textContent).toBe("Your Shares");
  });

  it("is offered whatever the record says: Shares parked can always be taken back", async () => {
    install({ wallet: 0n, parked: 400n * S });
    show({ contract: null, record: undefined as never });
    expect(await screen.findByTestId("take-back")).toBeTruthy();
  });

  it("a refusal says what happened in words and keeps the press", async () => {
    install({ wallet: 0n, parked: 400n * S });
    show();
    fireEvent.click(await screen.findByTestId("take-back"));
    chain.refuse = "execution reverted: TooMuch(1,0)";
    fireEvent.click(screen.getByTestId("take-back-confirm"));
    expect(
      (await screen.findByTestId("take-back-problem")).textContent,
    ).toMatch(/You have fewer Shares parked than that/);
    expect(screen.getByTestId("take-back-confirm")).toBeTruthy();
  });
});

describe("Take out of Shares that are parked", () => {
  it("all of it takes back what is parked first, then leaves with everything, in one press of two sends on a wallet", async () => {
    install({ wallet: 600n * S, parked: 400n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    expect(screen.getByTestId("takeout-held").textContent).toBe(
      "1,000 Shares (400 parked)",
    );
    expect(screen.getByTestId("takeout-unparks").textContent).toBe(
      "Taking out takes your parked Shares back first, in the same press. Your wallet is asked twice.",
    );
    // the cash is the sum of the wallet part and the parked part
    expect(screen.getByTestId("takeout-cash").textContent).toBe("9.80 dollars");
    const asked = chain.reads
      .filter((r) => r.name === "quoteTakeOut")
      .map((r) => [r.args[0], r.args[1]]);
    expect(asked).toContainEqual([BACKER_EVM, 600n * S]);
    expect(asked).toContainEqual([PAUSE, 400n * S]);
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
    const [first, second] = names();
    expect(first).toEqual(["unpark", PAUSE, 400n * S]);
    expect(second?.[0]).toBe("leave");
    expect(second?.[2]).toBe(1_000n * S);
  });

  it("a take-out that went out and was replaced without landing is not taken for landed because the wallet part is smaller (parked Shares count as held)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    install({ wallet: 600n * S, parked: 400n * S });
    // The call goes out and the network never applies it: what is held, wallet and parked together, is still 1,000.
    chain.onSend = null;
    chain.holdReceipts = true;
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.click(screen.getByTestId("takeout-portion-quarter"));
    await waitFor(() =>
      expect(screen.getByTestId("takeout-shares").textContent).toBe(
        "250 Shares",
      ),
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("sheet-problem");
    // The press again: the earlier call is gone under its hash ("replaced"), and the wallet's 600 is less than the 1,000
    // that were held, but 600 and 400 parked are not less. It is not found, so a new call is sent.
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
  }, 20_000);

  it("a part that the wallet covers does not touch what is parked", async () => {
    install({ wallet: 600n * S, parked: 400n * S });
    show();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.click(screen.getByTestId("takeout-portion-quarter"));
    await waitFor(() =>
      expect(screen.getByTestId("takeout-shares").textContent).toBe(
        "250 Shares",
      ),
    );
    expect(screen.queryByTestId("takeout-unparks")).toBeNull();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(names()[0]?.[0]).toBe("leave");
    expect(names()[0]?.[2]).toBe(250n * S);
  });

  it("a person who parked everything still holds, is offered Take out and gets the right amount", async () => {
    install({ wallet: 0n, parked: 1_000n * S });
    show();
    expect((await screen.findByTestId("holding-shares")).textContent).toBe(
      "1,000 Shares",
    );
    expect(screen.getByTestId("holding-cash").textContent).toBe("9.80 dollars");
    fireEvent.click(screen.getByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(2));
    expect(names()[0]).toEqual(["unpark", PAUSE, 1_000n * S]);
    expect(names()[1]?.[2]).toBe(1_000n * S);
  });

  it("a read of the pause that fails, where the record names one, stops the holding read and says nothing is lost", async () => {
    install({ wallet: 600n * S, parked: 400n * S }, { gate: "fails" });
    show();
    expect(
      (await screen.findByTestId("holding-read-failed")).textContent,
    ).toMatch(/Your money is not affected/);
  });

  it("with no pause in the record and none on the chain the take-out is the plain one call", async () => {
    install({ wallet: 600n * S, parked: 0n }, { gate: "none" });
    show({ contract: null, record: undefined as never });
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    expect(screen.queryByTestId("takeout-unparks")).toBeNull();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(names()[0]?.[0]).toBe("leave");
  });
});

describe("Start the day", () => {
  const reached = numbersWithPause({ parked: 200_000n * S });
  const showCard = () => {
    if (!reached.pause) throw new Error("the record has no pause");
    return wrap(
      <PauseCard
        holds
        now={reached.builtAt + 100}
        numbers={reached}
        pause={reached.pause}
      />,
    );
  };

  it("sends one poke to the pause contract the Treasury names", async () => {
    install({ wallet: 0n, parked: 0n });
    showCard();
    fireEvent.click(await screen.findByTestId("start-day"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(names()).toEqual([["poke", PAUSE]]);
    // Done: the press is gone, so a second press cannot be made on the old numbers.
    await waitFor(() => expect(screen.queryByTestId("start-day")).toBeNull());
  });

  it("sends nothing to a pause the Treasury does not name the way the record does, and says what happened", async () => {
    install({ wallet: 0n, parked: 0n }, { gate: "other" });
    showCard();
    fireEvent.click(await screen.findByTestId("start-day"));
    expect((await screen.findByTestId("start-day-problem")).textContent).toBe(
      "Starting the day did not go through. Nothing changed. Try again.",
    );
    expect(chain.sent.length).toBe(0);
  });
});
