// Bid with a wallet that has not shared an account with this site yet: the press asks the wallet to (the sheet needs the
// account), and a wallet that refuses is told so in words. It never does nothing (Review-Proven Rule 6).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
  return numbersOf(content);
}

type Ethereum = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/** A wallet that shares no account until asked: `eth_accounts` is empty, `eth_requestAccounts` answers `answer`. */
function unconnectedWallet(answer: "allow" | "refuse") {
  installChainStub({
    account: BACKER_EVM,
    block: 2_000,
    reads: { "quote()": `0x${addressWord(CONTRACTS.quote)}` },
  });
  const eth = (window as unknown as { ethereum: Ethereum }).ethereum;
  const real = eth.request.bind(eth);
  let shared = false;
  eth.request = async (args) => {
    if (args.method === "eth_accounts") return shared ? [BACKER_EVM] : [];
    if (args.method === "eth_requestAccounts") {
      if (answer === "refuse") throw { code: 4001, message: "User rejected" };
      shared = true;
      return [BACKER_EVM];
    }
    return real(args);
  };
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

async function typeAndPress() {
  await screen.findByTestId("bid-box");
  fireEvent.change(screen.getByTestId("bid-amount"), {
    target: { value: "250" },
  });
  fireEvent.click(screen.getByTestId("bid-review"));
}

describe("Bid before the wallet has shared an account", () => {
  it("asks the wallet for one and then opens the bid sheet", async () => {
    unconnectedWallet("allow");
    wrap(<MarketTop numbers={market()} />);
    await typeAndPress();
    await screen.findByTestId("bid-sheet");
  });

  it("says in words that the wallet did not share one, and opens no sheet", async () => {
    unconnectedWallet("refuse");
    wrap(<MarketTop numbers={market()} />);
    await typeAndPress();
    await waitFor(() =>
      expect(screen.getAllByRole("alert")[0].textContent).toMatch(
        /did not share an account/,
      ),
    );
    expect(screen.queryByTestId("bid-sheet")).toBeNull();
  });
});
