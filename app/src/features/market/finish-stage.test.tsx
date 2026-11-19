// An ended sale's Finish box follows the chain's own stage: a sale already finished there (the record has not caught up) has
// nothing left to press, and a sale still open keeps its one press.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChainStub, word } from "../../../tests/helpers/chain-stub";
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
import { MarketTop } from "./MarketTop";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const FLOOR = 31_691_265_005_800n;

function ended() {
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
    openedAt: NOW - 3 * 86_400,
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
  applyServerSettings(null);
});

describe("an ended sale's Finish box", () => {
  it("has nothing to press once the network says the sale is finished", async () => {
    installChainStub({
      account: BACKER_EVM,
      block: 8_400,
      reads: { "stage()": `0x${word(2)}` },
    });
    wrap(<MarketTop numbers={ended()} />);
    await screen.findByTestId("finish-done");
    expect(screen.queryByTestId("finish-press")).toBeNull();
  });

  it("keeps its one press while the sale is still open on the network", async () => {
    installChainStub({
      account: BACKER_EVM,
      block: 8_400,
      reads: { "stage()": `0x${word(1)}` },
    });
    wrap(<MarketTop numbers={ended()} />);
    await screen.findByTestId("finish-press");
    expect(screen.queryByTestId("finish-done")).toBeNull();
  });
});
