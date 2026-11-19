// A waiting call remembered from an earlier press is keyed by the step and what it was for (here the amount), so a later
// press with a different amount is sent, not answered "done" with the earlier call.
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
  addressWord,
  installChainStub,
  word,
} from "../../../tests/helpers/chain-stub";
import {
  COORDINATE,
  NOW,
  numbersOf,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  CONTRACTS,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { MarketTop } from "./MarketTop";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const FLOOR = 31_691_265_005_800n;

function market() {
  const content = numbersContent({
    coordinate: COORDINATE,
    now: NOW,
    stage: "team",
    runner: PAIR,
  });
  content.contracts = {
    ...(content.contracts as Record<string, unknown>),
    pair: PAIR,
  };
  content.sale = {
    auction: AUCTION,
    minimum: "100000000000",
    startBlock: "1000",
    endBlock: "8200",
    floorPriceQ96: FLOOR.toString(),
    tickSpacingQ96: (FLOOR / 100n).toString(),
    openedAt: NOW - 3600,
  };
  content.bids = [
    {
      auction: AUCTION,
      count: 5,
      amount: "120000000000",
      clearingPriceQ96: (FLOOR * 2n).toString(),
    },
  ];
  return numbersOf(content);
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  applyServerSettings(null);
});

describe("a waiting call from an earlier press must not answer a different amount", () => {
  it("sends a 1,000-dollar bid in full even though a 250-dollar bid once went out, waited, and has since landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = installChainStub({
      account: BACKER_EVM,
      block: 2_000,
      reads: { "quote()": `0x${addressWord(CONTRACTS.quote)}` },
    });
    wrap(<MarketTop numbers={market()} />);
    await screen.findByTestId("bid-box");
    // The first press: its first call goes out, and the wallet never shows it landing before the wait runs out.
    stub.holdReceipts = true;
    fireEvent.change(screen.getByTestId("bid-amount"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByTestId("bid-review"));
    fireEvent.click(await screen.findByTestId("bid-sheet-confirm"));
    await waitFor(() => expect(stub.sent).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    await screen.findByTestId("bid-sheet-problem");
    // It lands afterwards. The person comes back and bids 1,000.
    stub.holdReceipts = false;
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(screen.queryByTestId("bid-sheet")).toBeNull());
    fireEvent.change(screen.getByTestId("bid-amount"), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByTestId("bid-review"));
    fireEvent.click(await screen.findByTestId("bid-sheet-confirm"));
    await waitFor(() => expect(screen.queryByTestId("bid-sheet")).toBeNull());
    // The new bid went out whole: its own approvals and then the bid for 1,000 dollars, never the 250's remains.
    const bids = stub.sent.filter((c) => c.to === AUCTION);
    expect(bids).toHaveLength(1);
    expect(bids[0].data).toContain(word(1_000_000_000n));
    expect(stub.sent).toHaveLength(1 + 3);
  });
});
