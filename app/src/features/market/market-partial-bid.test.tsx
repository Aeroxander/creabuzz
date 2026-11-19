// An oversubscribed auction clears at the top price every app bid names, so every bid is only partly filled at the final
// price. The app settles it with the auction's own hints (the last checkpoint below the bid's price, and 0 for "not
// outbid"), read from its checkpoint list at the press, then takes the Shares. `tests/anvil/oversubscribed.test.ts`
// proves the same on a real EVM.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { exitCall } from "./exit-plan";
import { collectCalls } from "./market-calls";
import { MarketMoney } from "./MarketMoney";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const FLOOR = 31_691_265_005_800n;
const LAST = (1n << 64n) - 1n;

function oversubscribed() {
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
    settled: {
      raised: "400000000000",
      afterFee: "388000000000",
      toTreasury: "300000000000",
    },
  };
  content.bids = [
    {
      auction: AUCTION,
      count: 9,
      amount: "900000000000",
      clearingPriceQ96: (FLOOR * 4n).toString(),
    },
  ];
  return numbersOf(content);
}

/** The auction as the bidder sees it: the bid at the top price, the price walk 1x, 2x, then 4x (the top) to the end. */
function chain(stage: bigint) {
  return installChainStub({
    account: BACKER_EVM,
    block: 8_400,
    logs: () => [
      {
        address: AUCTION,
        topics: ["0x", `0x${word(3)}`, `0x${addressWord(BACKER_EVM)}`],
        data: `0x${word(FLOOR * 4n)}${word(250_000_000n)}`,
        blockNumber: "0x7d0",
      },
    ],
    reads: {
      "bids(uint256)": `0x${word(2_000)}${word(0)}${word(0)}${word(FLOOR * 4n)}${addressWord(BACKER_EVM)}${word(0)}${word(0)}`,
      "isGraduated()": `0x${word(1)}`,
      "claimBlock()": `0x${word(8_201)}`,
      "clearingPrice()": `0x${word(FLOOR * 4n)}`,
      "endBlock()": `0x${word(8_200)}`,
      "stage()": `0x${word(stage)}`,
      "checkpoints(uint64)": (_to, data) => {
        const at = BigInt(`0x${data.slice(10)}`);
        const row = (price: bigint, next: bigint) =>
          `0x${word(price)}${word(0)}${word(0)}${word(0)}${word(0)}${word(next)}`;
        if (at === 2_000n) return row(FLOOR, 3_000n);
        if (at === 3_000n) return row(FLOOR * 2n, 8_200n);
        if (at === 8_200n) return row(FLOOR * 4n, LAST);
        return `0x${word(0).repeat(6)}`;
      },
    },
  });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("an oversubscribed auction", () => {
  it("settles a bid at the final price with the auction's hints, then takes its Shares", async () => {
    const stub = chain(2n);
    wrap(<MarketMoney numbers={oversubscribed()} />);
    const bid = await screen.findByTestId("my-bid");
    expect(bid.textContent).not.toMatch(/not ready/i);
    fireEvent.click(await screen.findByTestId("collect-bid"));
    await waitFor(() => expect(stub.sent.length).toBe(2));
    expect(stub.sent.map((c) => c.data)).toEqual(
      collectCalls(AUCTION, 3n, {
        // The last checkpoint under the bid's price is block 3,000; it was never outbid, so the outbid block is 0.
        exit: exitCall(AUCTION, 3n, {
          kind: "partial",
          lastFullyFilled: 3_000n,
          outbid: 0n,
        }),
        claim: true,
      }).map((c) => c.data),
    );
  });

  it("offers nothing to collect until the sale is finished, and says why", async () => {
    // Before the pool step the auction still reads as not graduated and without its last checkpoint: collecting is refused.
    chain(1n);
    wrap(<MarketMoney numbers={oversubscribed()} />);
    const bid = await screen.findByTestId("my-bid");
    expect(bid.textContent).toMatch(/once the sale is finished/);
    expect(screen.queryByTestId("collect-bid")).toBeNull();
  });
});
