// The bid screens carry the plan's disclosure (section 6: Shares already held, by how many accounts, at what price, and when
// they release) so nobody bids from the project's first screen without it, and they do not promise one price for everyone:
// the auction is a continuous clearing auction, where a bid is filled at the price of each moment it is live
// (contracts/next/lib/continuous-clearing-auction/docs/TechnicalDocumentation.md).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressWord,
  installChainStub,
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

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

async function openSheet() {
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
  installChainStub({
    account: BACKER_EVM,
    block: 2_000,
    reads: { "quote()": `0x${addressWord(CONTRACTS.quote)}` },
  });
  wrap(<MarketTop numbers={numbersOf(content)} />);
  await screen.findByTestId("bid-box");
  fireEvent.change(screen.getByTestId("bid-amount"), {
    target: { value: "250" },
  });
  fireEvent.click(screen.getByTestId("bid-review"));
  await screen.findByTestId("bid-sheet");
}

describe("the bid screens carry the disclosure", () => {
  it("the bid box or its sheet says how many Shares are already held and by how many accounts", async () => {
    await openSheet();
    const seen = `${screen.getByTestId("bid-box").textContent} ${screen.getByTestId("bid-sheet").textContent}`;
    expect(seen).toMatch(/already held/i);
  });

  // The vendored auction is a continuous clearing auction (contracts/next/lib/continuous-clearing-auction/docs/
  // TechnicalDocumentation.md lines 38-44): a clearing price is uniform within one block only, a bid is filled over the
  // blocks it was live at each block's price (`cumulativeMpsPerPrice`), and the docs say not to assume a block settles at
  // one price. So an early bid and a late one do not pay one price, and the sheet's words are false.
  it("the bid sheet does not promise one price for everyone, the one the auction ends at", async () => {
    await openSheet();
    expect(screen.getByTestId("bid-sheet").textContent).not.toMatch(
      /Everyone pays the same price/i,
    );
  });
});
