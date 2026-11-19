// A sale that missed its minimum is closed as Failed (`Finisher.Stage.Failed`) and the Launcher lets the Pair open it
// again after `retryBlock`. The record of numbers keeps the failed sale as the one sale, so the app reads the stage from
// the chain: the Pair can open an auction (or a round) again, and the page stops saying the closed sale needs closing.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
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
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { MarketTop } from "../market/MarketTop";
import { TeamTop } from "./TeamTop";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const FOUNDER = COORDINATE.split(":")[1];
const FLOOR = 31_691_265_005_800n;

/** Team project, its one auction ended at block 8,200 with 40,000 dollars bid (under the 100,000 minimum). */
function failedSale() {
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
      count: 4,
      amount: "40000000000",
      clearingPriceQ96: FLOOR.toString(),
    },
  ];
  return numbersOf(content);
}

const chain = (retryBlock = 15_000) =>
  installChainStub({
    account: FOUNDER_EVM,
    block: 20_000,
    reads: {
      "first()": `0x${addressWord(FOUNDER_EVM)}`,
      "second()": `0x${addressWord(BACKER_EVM)}`,
      "stage()": `0x${word(3)}`, // Finisher.Stage.Failed
      "retryBlock()": `0x${word(retryBlock)}`,
    },
  });

const teamTop = () => (
  <TeamTop
    founder={FOUNDER}
    numbers={failedSale()}
    profiles={{}}
    team={[FOUNDER]}
  />
);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("after a sale failed", () => {
  it("the Pair can ask to open the auction or a backing round again", async () => {
    chain();
    wrap(teamTop());
    await screen.findByTestId("pair-sale-failed");
    expect(await screen.findByTestId("pair-open-auction")).not.toBeNull();
    expect(screen.queryByTestId("pair-open-round")).not.toBeNull();
  });

  it("waits for the block the Launcher names before offering a new auction, and says which", async () => {
    chain(25_000);
    wrap(teamTop());
    const said = await screen.findByTestId("pair-sale-failed");
    expect(said.textContent).toMatch(/from block 25000, in 5000 more blocks/);
    expect(screen.queryByTestId("pair-open-auction")).toBeNull();
  });

  it("the page says the sale missed its minimum instead of saying it needs closing", async () => {
    chain();
    wrap(<MarketTop numbers={failedSale()} />);
    await screen.findByTestId("failed-sale");
    expect(screen.queryByTestId("finish-box")).toBeNull();
  });
});
