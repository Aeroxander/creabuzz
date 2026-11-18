// The money screens against the attacks found in review of milestone 6 part 2 (A1 to A9 in PLANV2-M6-REPORT.md's
// "Review fixes"; A10, the waiting calls, is in money-sends.test.tsx). Each test failed before its fix.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  coordinateOf,
  DAY,
  installWallet,
  NOW,
  numbersOf,
  record,
  SERVER,
  sent,
  serve,
  served,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  CONTRACTS,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { BackBox } from "./BackBox";
import { MoneyTab } from "./MoneyTab";
import { OpenRounds } from "./OpenRounds";
import { openRound, type ProjectNumbers } from "./numbers";
import { Receipts } from "./Receipts";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

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

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
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
    serve([record(content)]);
    wrap(<Receipts />);
    const shares = await screen.findByTestId("receipt-shares");
    expect(shares.textContent).not.toMatch(/Your Shares:\s*0 held/);
  });
});

describe("A4: a backer's receipts survive more than 100 projects with numbers", () => {
  it("still shows the receipt when 100 newer projects have records", async () => {
    // The backer's project: its record was last signed 10 days ago (nothing moved since).
    serve([
      record(
        numbersContent({ coordinate: COORDINATE, now: NOW - 10 * DAY }),
        COORDINATE,
        NOW - 10 * DAY,
      ),
    ]);
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
    serve([record(content)]);
    wrap(<Receipts />);
    fireEvent.click(await screen.findByTestId("receipt-take-out"));
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(0);
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
    await screen.findByText(/^Backed with 25 dollars\./);
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
