// The auction's state is decided from the block number of the network the project lives on. A wallet sitting on another
// network has its own block numbers: a live auction must not read as ended because that network's block is higher.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChainStub } from "../../../tests/helpers/chain-stub";
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
  content.asOf = { block: 2_000, time: NOW };
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
  applyServerSettings(null);
});

describe("a wallet on another network", () => {
  it("does not turn a live auction into 'ended' because the other network's block number is higher", async () => {
    const numbers = market();
    expect(numbers.chainId).toBe(31337);
    installChainStub({ account: BACKER_EVM, block: 22_000_000 });
    const eth = (
      window as unknown as {
        ethereum: {
          request: (a: {
            method: string;
            params?: unknown[];
          }) => Promise<unknown>;
        };
      }
    ).ethereum;
    const real = eth.request.bind(eth);
    eth.request = async (args) =>
      args.method === "eth_chainId" ? "0x1" : real(args);
    wrap(<MarketTop numbers={numbers} />);
    // Let the wallet's block be read (or not): either way the live auction must not be called ended.
    await waitFor(() =>
      expect(
        screen.queryByTestId("bid-box") ?? screen.queryByTestId("finish-box"),
      ).not.toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 400)); // the wallet's block number has been read by now
    expect(screen.queryByTestId("finish-box")).toBeNull();
  });
});
