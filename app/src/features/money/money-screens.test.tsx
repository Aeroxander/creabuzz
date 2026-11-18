// The money screens against the attacks found in review of milestone 6 part 2 (A1 to A10 in PLANV2-M6-REPORT.md's
// "Review fixes"). Each test failed before its fix.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKER_EVM,
  CONTRACTS,
  chainIdentity,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { ToastProvider } from "../../ui/toast";
import { BackBox } from "./BackBox";
import { MoneyTab } from "./MoneyTab";
import { OpenRounds } from "./OpenRounds";
import {
  type NumbersEvent,
  openRound,
  parseNumbers,
  type ProjectNumbers,
} from "./numbers";
import { forgetPending, rememberPending } from "./pending-sends";
import { Receipts } from "./Receipts";

const SERVER = "f".repeat(64);
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const coordinateOf = (i: number) => `37001:${"b".repeat(64)}:p${i}`;
const COORDINATE = coordinateOf(0);

/** What the mocked server holds; `read` answers like the relay: matching kinds, #d and until, newest first, cut at `limit`. */
let served: NumbersEvent[] = [];
vi.mock("../../lib/relay", () => ({
  read: async (filter: {
    kinds?: number[];
    "#d"?: string[];
    limit?: number;
    until?: number;
  }) =>
    served
      .filter((e) => !filter.kinds || filter.kinds.includes(e.kind))
      .filter((e) => filter.until === undefined || e.created_at <= filter.until)
      .filter(
        (e) =>
          !filter["#d"] ||
          e.tags.some((t) => t[0] === "d" && filter["#d"]?.includes(t[1])),
      )
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit ?? served.length),
  publishAsUser: async () => undefined,
}));

function record(
  content: Record<string, unknown>,
  coordinate = COORDINATE,
  at = NOW,
): NumbersEvent {
  return {
    id: `${at.toString(16)}${coordinate.slice(-3)}`.padStart(64, "0"),
    pubkey: SERVER,
    kind: 39009,
    created_at: at,
    tags: [["d", chainIdentity(coordinate).key]],
    content: JSON.stringify(content),
  };
}

function numbersOf(content: Record<string, unknown>): ProjectNumbers {
  const parsed = parseNumbers(record(content), SERVER, {
    coordinate: COORDINATE,
    chainKey: chainIdentity(COORDINATE).key,
  });
  if (!parsed || parsed.removed) throw new Error("not parsed");
  return parsed;
}

/**
 * A wallet in the page that records every transaction and answers at once (or never, for the `pendingFrom`th send). It
 * starts on `chain` (the project's network, 31337, unless given) and switches when asked; off the project's network
 * a read answers nothing, as a real one does.
 */
let sent: { to: string; data: string }[] = [];
function installWallet(
  options: {
    pendingFrom?: number;
    chain?: string;
    /** What the network says of a hash this wallet never sent (eth_getTransactionByHash). */
    known?: (hash: string) => unknown;
    /** Hashes sent earlier (before this page) that have landed. */
    landedEarlier?: string[];
  } = {},
) {
  sent = [];
  let chain = options.chain ?? "0x7a69";
  (window as unknown as { ethereum: unknown }).ethereum = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts")
        return [BACKER_EVM];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        chain = (params?.[0] as { chainId: string }).chainId;
        return null;
      }
      if (method === "eth_getTransactionByHash" && options.known)
        return options.known(String(params?.[0]));
      if (method === "eth_call")
        return chain === "0x7a69"
          ? `0x${"0".repeat(24)}${CONTRACTS.quote.slice(2)}`
          : "0x";
      if (method === "eth_sendTransaction") {
        sent.push(params?.[0] as { to: string; data: string });
        return `0x${sent.length.toString(16).padStart(64, "0")}`;
      }
      if (method === "eth_getTransactionReceipt") {
        const hash = String(params?.[0]);
        if (options.landedEarlier?.includes(hash)) return { status: "0x1" };
        const n = Number.parseInt(hash, 16);
        if (!(n >= 1 && n <= sent.length)) return null; // not sent from this page
        if (options.pendingFrom !== undefined && n === options.pendingFrom)
          return null;
        return { status: "0x1" };
      }
      throw { code: 4200, message: method };
    },
  };
}

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}

async function openBackSheet(numbers: ProjectNumbers, amount = "25") {
  const round = openRound(numbers, NOW);
  if (!round) throw new Error("no open round");
  wrap(
    <BackBox
      now={NOW}
      numbers={numbers}
      primary
      projectName="Lantern"
      round={round}
    />,
  );
  fireEvent.change(screen.getByTestId("back-amount"), {
    target: { value: amount },
  });
  fireEvent.click(screen.getByTestId("back-review"));
  return screen.findByTestId("back-sheet");
}

const isAsk = (c: { to: string }) => c.to === CONTRACTS.rounds;
const BACK_ACTION = `back:31337:${CONTRACTS.rounds}:2`;

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  served = [];
  installWallet();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  applyServerSettings(null);
});

describe("A1: Back cannot be sent twice by a quick double press", () => {
  it("asks the wallet for one approval and one ask only", async () => {
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    await openBackSheet(numbers);
    const confirm = screen.getByTestId("back-confirm");
    // Two taps handled before React re-renders the button as disabled (TanStack Query flushes isPending on a
    // setTimeout(0), and the browser runs queued input before timers).
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.filter(isAsk)).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });
});

describe("A2: a receipt that was taken back reads as taken back (the server's shape)", () => {
  it("parses refunded as the server writes it: {paid, at}", () => {
    const content = numbersContent({ coordinate: COORDINATE, now: NOW });
    const receipts = content.receipts as Record<string, unknown>[];
    // crates/buzz-relay/src/chain_reader/numbers.rs writes `"refunded": {"paid": "...", "at": <unix>}` once refunded.
    receipts[0].refunded = { paid: "77900000", at: NOW - DAY };
    const numbers = numbersOf(content);
    expect(numbers.receipts[0].refunded).toBe(NOW - DAY);
  });
});

describe("A3: Your Shares are never said to be 0 when the holders list was cut", () => {
  it("does not tell a backer missing from a cut holders list that they hold 0 Shares", async () => {
    const content = numbersContent({ coordinate: COORDINATE, now: NOW });
    // More than 200 holders: the server cut the list (biggest first) and the small backer fell off it.
    content.truncated = true;
    content.holderCount = 250;
    content.holders = (content.holders as Record<string, unknown>[]).filter(
      (h) => h.account !== BACKER_EVM,
    );
    served = [record(content)];
    wrap(<Receipts />);
    const shares = await screen.findByTestId("receipt-shares");
    expect(shares.textContent).not.toMatch(/Your Shares:\s*0 held/);
  });
});

describe("A4: a backer's receipts survive more than 100 projects with numbers", () => {
  it("still shows the receipt when 100 newer projects have records", async () => {
    // The backer's project: its record was last signed 10 days ago (nothing moved since).
    served = [
      record(
        numbersContent({ coordinate: COORDINATE, now: NOW - 10 * DAY }),
        COORDINATE,
        NOW - 10 * DAY,
      ),
    ];
    for (let i = 1; i <= 100; i += 1) {
      const c = coordinateOf(i);
      served.push(
        record(
          numbersContent({ coordinate: c, now: NOW - i, backed: false }),
          c,
          NOW - i,
        ),
      );
    }
    wrap(<Receipts />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("receipts-none") ??
          screen.queryByTestId("receipt"),
      ).not.toBeNull(),
    );
    expect(
      screen.queryByTestId("receipts-none")?.textContent ?? "",
    ).not.toMatch(/has not backed/);
    expect(screen.queryAllByTestId("receipt")).toHaveLength(1);
  });
});

describe("A4: Home never says no round is open when it read only the newest records", () => {
  it("says what it read instead", async () => {
    for (let i = 1; i <= 100; i += 1) {
      const c = coordinateOf(i);
      served.push(
        record(
          numbersContent({ coordinate: c, now: NOW - i, backed: false }),
          c,
          NOW - i,
        ),
      );
    }
    wrap(<OpenRounds projects={[]} />);
    const none = await screen.findByTestId("rounds-none");
    expect(none.textContent).not.toMatch(/right now/);
    expect(none.textContent).toMatch(/newest/);
  });
});

describe("A5: the Back sheet says how much can really come back", () => {
  it("states the most of each 100 that can be taken back (77.90 on day 0), not 'less 5 of each 100'", async () => {
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    const sheet = await openBackSheet(numbers, "100");
    expect(sheet.textContent).toMatch(/77\.9/);
  });
});

describe("A6: Back discloses an earlier round sold cheaper", () => {
  it("names round 1's price when the open round costs more", async () => {
    const content = numbersContent({
      coordinate: COORDINATE,
      now: NOW,
      openRound: { openedAgo: 3600 },
    });
    // Rounds.sol: "A later round may be priced higher or lower than an earlier one." Round 2 at 1,000 Shares a dollar,
    // three times round 1's price (3,000 a dollar).
    const rounds = content.rounds as Record<string, unknown>[];
    rounds[1].sharesPerRawDollar = "1000000000000000";
    rounds[1].projectPrice = "1000000.00";
    const numbers = numbersOf(content);
    const sheet = await openBackSheet(numbers);
    const box = screen.getByTestId("back-box");
    expect(`${box.textContent} ${sheet.textContent}`).toMatch(/3,000/);
  });
});

describe("A7: Back says the round is already oversubscribed", () => {
  it("shows what was asked so far when it is more than the round holds", async () => {
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        // 30,000 dollars asked of a 7,500-dollar round: each ask gets 25%.
        openRound: { openedAgo: 3600, asked: "30000000000", backers: 40 },
      }),
    );
    const sheet = await openBackSheet(numbers);
    const box = screen.getByTestId("back-box");
    expect(`${box.textContent} ${sheet.textContent}`).toMatch(/30,000|25%/);
  });
});

describe("A8: a round past its 24 hours is never called open", () => {
  it("does not say 'open now' for a round that stopped taking asks but was not closed yet", () => {
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: DAY + 600 },
      }),
    );
    wrap(
      <MoneyTab
        error={null}
        loading={false}
        now={NOW}
        numbers={numbers}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("money-rounds").textContent).not.toMatch(
      /open now/,
    );
  });
});

describe("A9: taking out released Shares (which ends their refund) is never one unreviewed press", () => {
  it("does not send claimHeld on the first press", async () => {
    const content = numbersContent({
      coordinate: COORDINATE,
      now: NOW,
      stage: "team",
    });
    (content.stage as Record<string, unknown>).name = "council";
    served = [record(content)];
    wrap(<Receipts />);
    fireEvent.click(await screen.findByTestId("receipt-take-out"));
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(0);
  });
});

describe("A10: a Back whose ask has not landed cannot be sent again as a second ask", () => {
  it("does not send a second ask after 'not landed yet'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet({ pendingFrom: 2 }); // the first ask never lands in time; everything else does
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    await openBackSheet(numbers);
    fireEvent.click(screen.getByTestId("back-confirm"));
    await waitFor(() => expect(sent).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("back-problem");
    const confirm = screen.getByTestId("back-confirm");
    if (!(confirm as HTMLButtonElement).disabled) fireEvent.click(confirm);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent.filter(isAsk)).toHaveLength(1);
    forgetPending(BACK_ACTION);
  });

  it("sends afresh once the network says the earlier call was never seen (the way back is never lost)", async () => {
    rememberPending(BACK_ACTION, {
      hash: `0x${"9".repeat(64)}`,
      index: 1,
      total: 2,
      chainId: 31337,
      at: NOW,
    });
    installWallet({ known: () => null });
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    await openBackSheet(numbers);
    expect(screen.getByTestId("back-confirm").textContent).toBe(
      "Look for your backing",
    );
    fireEvent.click(screen.getByTestId("back-confirm"));
    await screen.findByText(/^Backed\./);
    expect(sent).toHaveLength(2);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });

  it("sends only the ask once the earlier approval is found to have landed", async () => {
    rememberPending(BACK_ACTION, {
      hash: `0x${"8".repeat(64)}`,
      index: 0,
      total: 2,
      chainId: 31337,
      at: NOW,
    });
    installWallet({ landedEarlier: [`0x${"8".repeat(64)}`] });
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    await openBackSheet(numbers);
    fireEvent.click(screen.getByTestId("back-confirm"));
    await screen.findByText(/^Backed\./);
    expect(sent).toHaveLength(1);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });
});

describe("F1: Back works when the wallet starts on another network", () => {
  it("switches the wallet to the project's network before reading the dollar token", async () => {
    installWallet({ chain: "0x1" });
    const numbers = numbersOf(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    await openBackSheet(numbers);
    fireEvent.click(screen.getByTestId("back-confirm"));
    await screen.findByText(/^Backed\./);
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe(CONTRACTS.quote);
  });
});

describe("F8: the holders line counts every holder, not only the listed ones", () => {
  it("says 'held for 2 accounts' when only the receipts list was cut", () => {
    const content = numbersContent({ coordinate: COORDINATE, now: NOW });
    content.truncated = true;
    content.receiptCount = 250;
    content.holderCount = 2;
    wrap(
      <MoneyTab
        error={null}
        loading={false}
        now={NOW}
        numbers={numbersOf(content)}
        onRetry={() => {}}
      />,
    );
    const held = screen.getByTestId("money-held").textContent ?? "";
    expect(held).toMatch(/held for 2 accounts/);
    expect(held).not.toMatch(/more than|At least/);
  });
});
