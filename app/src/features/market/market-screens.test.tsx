// The market's screens through the components: the bid box (2 presses, 1 field, the exact calls), the finish steps,
// the pool's price beside its depth, Hand back, Buy and Sell only where trading is on, the disclosure before an
// auction, and collecting a bid.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { PERMIT2_ADDRESS } from "@creaton/core/launchpad/evmAbi.ts";
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
  CONTRACTS,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import {
  bidCalls,
  collectCalls,
  finishCall,
  handBackCalls,
  tradeCalls,
} from "./market-calls";
import { MarketMoney } from "./MarketMoney";
import { MarketTop } from "./MarketTop";
import { poolSlots } from "./use-market";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const MANAGER = "0x7e57000000000000000000000000000000000e57";
const HOOK = "0x9b3c000000000000000000000000000000002000";
const FLOOR = 31_691_265_005_800n;
const SHARE = 10n ** 18n;

/** A Team project's numbers with its one auction: opened at block 1,000 (it ends at 8,200), and what came after. */
function market(o: {
  bid?: string;
  settled?: boolean;
  pool?: boolean;
  truncated?: boolean;
}) {
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
    ...(o.settled
      ? {
          settled: {
            raised: "120000000000",
            afterFee: "116400000000",
            toTreasury: "90000000000",
          },
        }
      : {}),
    ...(o.pool
      ? {
          pool: {
            poolId: `0x${"22".repeat(32)}`,
            sqrtPriceX96: "1584563250285286751870879006720",
            poolDollars: "26400000000",
            poolShares: "66000000000000000000000000",
          },
        }
      : {}),
  };
  content.bids = [
    {
      auction: AUCTION,
      count: 5,
      amount: o.bid ?? "120000000000",
      clearingPriceQ96: (FLOOR * 2n).toString(),
    },
  ];
  if (o.truncated) {
    content.holderCount = 250;
    content.truncated = true;
  }
  return numbersOf(content);
}

const poolKeyWords = () =>
  `0x${addressWord(CONTRACTS.quote)}${addressWord(CONTRACTS.shares)}${word(10_000)}${word(200)}${addressWord(HOOK)}`;

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllEnvs();
});

describe("bidding", () => {
  it("bids in 2 presses and 1 field, at the most the auction allows, once per press", async () => {
    const stub = installChainStub({
      account: BACKER_EVM,
      block: 2_000,
      reads: { "quote()": `0x${addressWord(CONTRACTS.quote)}` },
    });
    wrap(<MarketTop numbers={market({})} />);
    const box = await screen.findByTestId("bid-box");
    expect(box.textContent).toMatch(/most anyone pays is 0\.0016/);
    fireEvent.change(screen.getByTestId("bid-amount"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByTestId("bid-review"));
    const confirm = await screen.findByTestId("bid-sheet-confirm");
    expect(screen.getByTestId("bid-sheet").textContent).toMatch(
      /Buyers acquire ownership only/,
    );
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(3));
    const expected = bidCalls({
      auction: AUCTION,
      quote: CONTRACTS.quote,
      owner: BACKER_EVM,
      amount: 250_000_000n,
      floorQ96: FLOOR,
      permit2Allowance: 0n,
      deadline: 0n,
    });
    expect(stub.sent.map((c) => c.to)).toEqual(expected.map((c) => c.to));
    expect(stub.sent[0].data).toBe(expected[0].data);
    expect(stub.sent[2].data).toBe(expected[2].data);
    expect(stub.sent[1].to).toBe(PERMIT2_ADDRESS.toLowerCase());
  });

  it("takes no bids in the auction's last stretch, and refuses an amount under 1 dollar", async () => {
    installChainStub({ account: BACKER_EVM, block: 7_900 });
    wrap(<MarketTop numbers={market({})} />);
    expect(await screen.findByTestId("bid-closing")).toBeTruthy();
    expect(screen.queryByTestId("bid-amount")).toBeNull();
    cleanup();
    installChainStub({ account: BACKER_EVM, block: 2_000 });
    wrap(<MarketTop numbers={market({})} />);
    await screen.findByTestId("bid-amount");
    fireEvent.change(screen.getByTestId("bid-amount"), {
      target: { value: "0.5" },
    });
    fireEvent.click(screen.getByTestId("bid-review"));
    expect(screen.getByText("A bid is at least 1 dollar.")).toBeTruthy();
    expect(screen.queryByTestId("bid-sheet")).toBeNull();
  });
});

describe("finishing", () => {
  it("finishes a sale that reached its minimum in one press, and only closes one that did not", async () => {
    const stub = installChainStub({ account: BACKER_EVM, block: 8_300 });
    wrap(<MarketTop numbers={market({})} />);
    fireEvent.click(await screen.findByTestId("finish-press"));
    await waitFor(() => expect(stub.sent.length).toBe(3));
    expect(stub.sent.map((c) => c.data)).toEqual(
      (["openPool", "settle", "sweep"] as const).map(
        (s) => finishCall(CONTRACTS.finisher, s).data,
      ),
    );
    cleanup();
    const failed = installChainStub({ account: BACKER_EVM, block: 8_300 });
    wrap(<MarketTop numbers={market({ bid: "50000000000" })} />);
    const press = await screen.findByTestId("finish-press");
    expect(press.textContent).toBe("Close the sale");
    fireEvent.click(press);
    await waitFor(() => expect(failed.sent.length).toBe(1));
    expect(failed.sent[0].data).toBe(
      finishCall(CONTRACTS.finisher, "sweep").data,
    );
  });
});

describe("the pool", () => {
  const reads = () => {
    const slots = poolSlots({
      currency0: CONTRACTS.quote,
      currency1: CONTRACTS.shares,
      fee: 10_000,
      tickSpacing: 200,
      hooks: HOOK,
    });
    // Dollars are currency0 here: sqrt(Shares per dollar, raw), for 0.0004 dollars a Share.
    const sqrt = BigInt(Math.round(Math.sqrt(2_500 * 1e12) * 2 ** 96));
    // 26,400 dollars beside 66,000,000 Shares in range.
    const liquidity = BigInt(Math.round(Math.sqrt(26_400e6 * 66e24)));
    return {
      "poolKey()": poolKeyWords(),
      "poolManager()": `0x${addressWord(MANAGER)}`,
      "extsload(bytes32)": (_to: string, data: string) =>
        data.endsWith(slots.slot0.slice(2))
          ? `0x${word(sqrt)}`
          : `0x${word(liquidity)}`,
      "melting()": `0x${word(60_000_000_000n)}`,
      "meltRemaining()": `0x${word(365n * 86_400n)}`,
      "permanentFloor()": `0x${word(0)}`,
      "countingSupply()": `0x${word(250_000_000n * SHARE)}`,
      "totalSupply()": `0x${word(1_000_000_000n * SHARE)}`,
      "saleClosed()": `0x${word(1)}`,
    };
  };

  it("shows the price beside its depth and the floor, and hands Shares back in 2 presses and 1 field", async () => {
    const stub = installChainStub({
      account: BACKER_EVM,
      block: 9_000,
      reads: reads(),
    });
    wrap(<MarketTop numbers={market({ settled: true, pool: true })} />);
    await waitFor(() =>
      expect(screen.getByTestId("pool-price").textContent).toBe(
        "0.0004 dollars a Share",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("pool-depth").textContent).toMatch(
        /A 100-dollar buy moves it about 0\.7/,
      ),
    );
    expect(screen.getByTestId("pool-floor").textContent).toMatch(/0\.00024/);
    // Trading is off: no Buy, no Sell.
    expect(screen.queryByTestId("buy")).toBeNull();
    fireEvent.click(screen.getByTestId("hand-back"));
    fireEvent.change(await screen.findByTestId("hand-back-amount"), {
      target: { value: "1000" },
    });
    expect(screen.getByTestId("hand-back-estimate").textContent).toMatch(
      /About 0\.22 dollars come back/,
    );
    fireEvent.click(screen.getByTestId("hand-back-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(2));
    expect(stub.sent.map((c) => c.data)).toEqual(
      handBackCalls(CONTRACTS.shares, CONTRACTS.treasury, 1_000n * SHARE).map(
        (c) => c.data,
      ),
    );
  });

  it("offers Buy and Sell only where the server turns trading on and the build names the router", async () => {
    applyServerSettings({ investing: true, trading: true, self: SERVER });
    installChainStub({ account: BACKER_EVM, block: 9_000, reads: reads() });
    wrap(<MarketTop numbers={market({ settled: true, pool: true })} />);
    await screen.findByTestId("pool-depth");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("buy")).toBeNull();
    cleanup();
    vi.stubEnv(
      "VITE_CREATON_ROUTER",
      "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b",
    );
    installChainStub({ account: BACKER_EVM, block: 9_000, reads: reads() });
    wrap(<MarketTop numbers={market({ settled: true, pool: true })} />);
    expect(await screen.findByTestId("buy")).toBeTruthy();
    expect(screen.getByTestId("sell")).toBeTruthy();
  });
});

describe("buying in the pool", () => {
  it("buys in 2 presses and 1 field through the router the build names, refusing a fill 5 of each 100 worse", async () => {
    applyServerSettings({ investing: true, trading: true, self: SERVER });
    const ROUTER = "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b";
    vi.stubEnv("VITE_CREATON_ROUTER", ROUTER);
    const slots = poolSlots({
      currency0: CONTRACTS.quote,
      currency1: CONTRACTS.shares,
      fee: 10_000,
      tickSpacing: 200,
      hooks: HOOK,
    });
    const sqrt = BigInt(Math.round(Math.sqrt(2_500 * 1e12) * 2 ** 96));
    const stub = installChainStub({
      account: BACKER_EVM,
      block: 9_000,
      reads: {
        "poolKey()": poolKeyWords(),
        "poolManager()": `0x${addressWord(MANAGER)}`,
        "extsload(bytes32)": (_to: string, data: string) =>
          data.endsWith(slots.slot0.slice(2))
            ? `0x${word(sqrt)}`
            : `0x${word(10n ** 21n)}`,
      },
    });
    wrap(<MarketTop numbers={market({ settled: true, pool: true })} />);
    fireEvent.click(await screen.findByTestId("buy"));
    fireEvent.change(await screen.findByTestId("trade-amount"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByTestId("trade-sheet-confirm"));
    await waitFor(() => expect(stub.sent.length).toBe(3));
    const expected = tradeCalls({
      router: ROUTER,
      key: {
        currency0: CONTRACTS.quote,
        currency1: CONTRACTS.shares,
        fee: 10_000,
        tickSpacing: 200,
        hooks: HOOK,
      },
      tokenIn: CONTRACTS.quote,
      amountIn: 100_000_000n,
      // 100 dollars at 0.0004 is 250,000 Shares; at least 95 of each 100 of that (237,500).
      minOut: 237_500n * SHARE,
      permit2Allowance: 0n,
      deadline: 0n,
    });
    expect(stub.sent.map((c) => c.to)).toEqual(expected.map((c) => c.to));
    expect(stub.sent[0].data).toBe(expected[0].data);
    // The router call carries its own deadline; everything before it is the same.
    expect(stub.sent[2].data.slice(0, 10)).toBe(expected[2].data.slice(0, 10));
    expect(stub.sent[2].data).toContain(word(237_500n * SHARE));
  });
});

describe("before and after the auction on the Money tab", () => {
  it("says who holds Shares already, at what price, and when they release, with at least on a cut list", () => {
    installChainStub({ account: BACKER_EVM, block: 2_000 });
    wrap(<MarketMoney numbers={market({ truncated: true })} />);
    expect(screen.getByTestId("disclosure-held").textContent).toMatch(
      /^At least 200,300,000 Shares are already held, by 250 accounts/,
    );
    expect(screen.getByTestId("disclosure-prices").textContent).toMatch(
      /Round 1: 2,500 dollars, where 1 dollar buys 3,000 Shares/,
    );
    expect(screen.getByTestId("disclosure-release").textContent).toMatch(
      /365 days from the day the market opens/,
    );
    expect(screen.getByTestId("disclosure-auction").textContent).toMatch(
      /from 0\.0004 dollars a Share; nobody pays more than 0\.0016/,
    );
  });

  it("collects a filled bid: settled, then its Shares taken", async () => {
    const stub = installChainStub({
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
        // Bid{startBlock, startCumulativeMps, exitedBlock, maxPrice, owner, amountQ96, tokensFilled}
        "bids(uint256)": `0x${word(2_000)}${word(0)}${word(0)}${word(FLOOR * 4n)}${addressWord(BACKER_EVM)}${word(0)}${word(0)}`,
        "isGraduated()": `0x${word(1)}`,
        "claimBlock()": `0x${word(8_201)}`,
        "clearingPrice()": `0x${word(FLOOR * 2n)}`,
      },
    });
    wrap(<MarketMoney numbers={market({ settled: true, pool: true })} />);
    const bid = await screen.findByTestId("my-bid");
    expect(bid.textContent).toMatch(/250 dollars/);
    fireEvent.click(screen.getByTestId("collect-bid"));
    await waitFor(() => expect(stub.sent.length).toBe(2));
    expect(stub.sent.map((c) => c.data)).toEqual(
      collectCalls(AUCTION, 3n, { exit: true, claim: true }).map((c) => c.data),
    );
  });
});
