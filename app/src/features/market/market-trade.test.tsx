// Selling in the pool and a sale that did not reach its minimum, through the components: the exact calls a Sell sends
// (whichever side of the pool the Shares are), the field cleared between Buy and Sell, and a bid in a failed sale
// collecting only its dollars.
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
import { MarketMoney } from "./MarketMoney";
import { MarketTop } from "./MarketTop";
import { collectCalls, type PoolKey, tradeCalls } from "./market-calls";
import { poolSlots } from "./use-market";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const MANAGER = "0x7e57000000000000000000000000000000000e57";
const HOOK = "0x9b3c000000000000000000000000000000002000";
const ROUTER = "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b";
/** A dollar token above the Shares' address, so the Shares are the pool's first token. */
const HIGH_QUOTE = "0xff00000000000000000000000000000000000001";
const FLOOR = 31_691_265_005_800n;
const SHARE = 10n ** 18n;

function market(o: { raised: string; pool: boolean }) {
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
    ...(o.pool
      ? {
          settled: {
            raised: o.raised,
            afterFee: "116400000000",
            toTreasury: "90000000000",
          },
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
      amount: o.raised,
      clearingPriceQ96: (FLOOR * 2n).toString(),
    },
  ];
  return numbersOf(content);
}

/** A pool at 0.0004 dollars a Share with `key`, as the wallet's node answers for it. */
function poolReads(key: PoolKey) {
  const slots = poolSlots(key);
  const sharesFirst = key.currency0 === CONTRACTS.shares;
  // sqrt(currency1 per currency0, raw): 2,500 Shares a dollar is 2.5e15 raw Shares a raw dollar.
  const ratio = sharesFirst ? 1 / (2_500 * 1e12) : 2_500 * 1e12;
  const sqrt = BigInt(Math.round(Math.sqrt(ratio) * 2 ** 96));
  return {
    "poolKey()": `0x${addressWord(key.currency0)}${addressWord(key.currency1)}${word(key.fee)}${word(key.tickSpacing)}${addressWord(key.hooks)}`,
    "poolManager()": `0x${addressWord(MANAGER)}`,
    "extsload(bytes32)": (_to: string, data: string) =>
      data.endsWith(slots.slot0.slice(2))
        ? `0x${word(sqrt)}`
        : `0x${word(10n ** 21n)}`,
  };
}

const QUOTE_FIRST: PoolKey = {
  currency0: CONTRACTS.quote,
  currency1: CONTRACTS.shares,
  fee: 10_000,
  tickSpacing: 200,
  hooks: HOOK,
};
const SHARES_FIRST: PoolKey = {
  currency0: CONTRACTS.shares,
  currency1: HIGH_QUOTE,
  fee: 10_000,
  tickSpacing: 200,
  hooks: HOOK,
};

beforeEach(() => {
  applyServerSettings({ investing: true, trading: true, self: SERVER });
  vi.stubEnv("VITE_CREATON_ROUTER", ROUTER);
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllEnvs();
});

describe("selling in the pool", () => {
  it.each([
    ["the dollar token is the pool's first token", QUOTE_FIRST],
    ["the Shares are the pool's first token", SHARES_FIRST],
  ])("sells in 2 presses and 1 field when %s, refusing a fill 5 of each 100 worse, once per press", async (_name, key) => {
    const stub = installChainStub({
      account: BACKER_EVM,
      block: 9_000,
      reads: poolReads(key),
    });
    wrap(
      <MarketTop numbers={market({ raised: "120000000000", pool: true })} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("pool-price").textContent).toBe(
        "0.0004 dollars a Share",
      ),
    );
    fireEvent.click(await screen.findByTestId("sell"));
    const confirm = await screen.findByTestId("trade-sheet-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("trade-amount"), {
      target: { value: "250000" },
    });
    expect(screen.getByTestId("trade-sheet").textContent).toMatch(
      /Buyers acquire ownership only/,
    );
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.sent.length).toBe(3));
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.sent.length).toBe(3);
    // 250,000 Shares at 0.0004 is 100 dollars; at least 95 of each 100 of that.
    const sentMin = BigInt(`0x${stub.sent[2].data.slice(-64)}`);
    expect(sentMin).toBeGreaterThanOrEqual(94_999_999n);
    expect(sentMin).toBeLessThanOrEqual(95_000_000n);
    const expected = tradeCalls({
      router: ROUTER,
      key,
      tokenIn: CONTRACTS.shares,
      amountIn: 250_000n * SHARE,
      minOut: sentMin,
      permit2Allowance: 0n,
      deadline: 0n,
    });
    expect(stub.sent.map((c) => c.to)).toEqual([
      CONTRACTS.shares,
      PERMIT2_ADDRESS.toLowerCase(),
      ROUTER,
    ]);
    expect(stub.sent[0].data).toBe(expected[0].data);
    // The Permit2 approval and the router call carry their own deadline; everything else is the same.
    const deadline = stub.sent[2].data.slice(10 + 128, 10 + 192);
    const withDeadline = tradeCalls({
      router: ROUTER,
      key,
      tokenIn: CONTRACTS.shares,
      amountIn: 250_000n * SHARE,
      minOut: sentMin,
      permit2Allowance: 0n,
      deadline: BigInt(`0x${deadline}`),
    });
    expect(stub.sent[1].data).toBe(withDeadline[1].data);
    expect(stub.sent[2].data).toBe(withDeadline[2].data);
    // Within ten minutes from now, never open-ended.
    const seconds = Number(BigInt(`0x${deadline}`)) - Date.now() / 1000;
    expect(seconds).toBeGreaterThan(500);
    expect(seconds).toBeLessThanOrEqual(600);
  });

  it("starts Sell with an empty field after an amount was typed under Buy", async () => {
    const stub = installChainStub({
      account: BACKER_EVM,
      block: 9_000,
      reads: poolReads(QUOTE_FIRST),
    });
    wrap(
      <MarketTop numbers={market({ raised: "120000000000", pool: true })} />,
    );
    fireEvent.click(await screen.findByTestId("buy"));
    fireEvent.change(await screen.findByTestId("trade-amount"), {
      target: { value: "100" },
    });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("trade-amount")).toBeNull(),
    );
    fireEvent.click(screen.getByTestId("sell"));
    const field = (await screen.findByTestId(
      "trade-amount",
    )) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(
      (screen.getByTestId("trade-sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(stub.sent.length).toBe(0);
  });
});

describe("a sale that did not reach its minimum", () => {
  it("collects a bid's dollars only: settled, and no Shares asked for", async () => {
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
        "bids(uint256)": `0x${word(2_000)}${word(0)}${word(0)}${word(FLOOR * 4n)}${addressWord(BACKER_EVM)}${word(0)}${word(0)}`,
        "isGraduated()": `0x${word(0)}`,
        "claimBlock()": `0x${word(8_201)}`,
        "clearingPrice()": `0x${word(FLOOR)}`,
      },
    });
    wrap(
      <MarketMoney numbers={market({ raised: "50000000000", pool: false })} />,
    );
    const bid = await screen.findByTestId("my-bid");
    expect(bid.textContent).toMatch(
      /The auction did not reach its minimum: collect your dollars\./,
    );
    fireEvent.click(screen.getByTestId("collect-bid"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.sent.map((c) => c.data)).toEqual(
      collectCalls(AUCTION, 3n, { exit: true, claim: false }).map(
        (c) => c.data,
      ),
    );
  });
});
