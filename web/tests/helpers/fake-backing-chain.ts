import {
  BACKING_STRUCT_TYPES,
  BACKING_TOPICS,
} from "@creaton/core/launchpad/backing.ts";
import {
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import type { Page } from "@playwright/test";

/**
 * A stand-in chain node for the backing specs: it answers the calls and log reads the Backing block makes about ONE
 * project's pool, from a fixture a spec describes, and records every transaction the page's wallet sends. It is the
 * layout of the contracts' own structs (`snapshot`, `roundInfo`) as the app decodes them, so a spec fails if the decoder
 * and the layout disagree; the real contracts answer the same calls in `scripts/web-backing-e2e.sh`.
 */

const E18 = 10n ** 18n;
export const QUOTE_DECIMALS = 6;
const ONE = 10n ** BigInt(QUOTE_DECIMALS);
const MAX = (1n << 256n) - 1n;
/** The round's floor: 0.000025 whole tokens per whole claim token, in a 6-decimal quote, in the auction's fixed point. */
const FLOOR_X96 = ((1n << 96n) * 25n) / 10n ** 18n;
const TICK_X96 = FLOOR_X96 / 100n;

export const FIXTURE = {
  chainId: 31337,
  factory: `0x${"fa".repeat(20)}`,
  kit: `0x${"b2".repeat(20)}`,
  token: `0x${"c0".repeat(20)}`,
  pool: `0x${"90".repeat(20)}`,
  dao: `0x${"da".repeat(20)}`,
  auction: `0x${"a7".repeat(20)}`,
  claim: `0x${"c1".repeat(20)}`,
  founderWallet: `0x${"f0".repeat(20)}`,
  backerWallet: `0x${"b0".repeat(20)}`,
} as const;

export interface PoolFixture {
  /** The pool's phase: how the round and the abandonment words are set. */
  phase: "live" | "waiting" | "failed" | "abandoned" | "no-round";
  /** Quote base units. */
  escrow: bigint;
  released: bigint;
  reserve: bigint;
  /** What the viewing wallet holds. */
  holderUnits: bigint;
  holderEscrow: bigint;
  holderSellValue: bigint;
  holderCanLeave: boolean;
  holderLeaveValue: bigint;
  holderClaimTokens: bigint;
  holderEarlyLeft: bigint | null;
  /** Seconds from the chain's now: when the window to leave ends, or null for no open milestone. */
  windowEndsIn: number | null;
  /** When the next milestone can be posted, seconds from now (negative: already). */
  nextClaimIn: number;
  /** A milestone's pointed-at record, 64 hex. */
  milestoneRef: string;
  /** Blocks until the round ends (waiting only; negative: ended). */
  roundBlocksLeft: number;
  roundMinimum: bigint;
  roundRaised: bigint;
  /** Events the pool logged (already encoded). */
  events: { topics: string[]; data: string; block: number }[];
}

export const POOL_DEFAULTS: PoolFixture = {
  phase: "live",
  escrow: 220n * ONE,
  released: 40n * ONE,
  reserve: 2_000n * ONE,
  holderUnits: 0n,
  holderEscrow: 0n,
  holderSellValue: 0n,
  holderCanLeave: false,
  holderLeaveValue: 0n,
  holderClaimTokens: 0n,
  holderEarlyLeft: null,
  windowEndsIn: null,
  nextClaimIn: 20 * 86_400,
  milestoneRef: "e".padEnd(64, "1"),
  roundBlocksLeft: 30_000,
  roundMinimum: 2_500n * ONE,
  roundRaised: 900n * ONE,
  events: [],
};

const word = (value: bigint | string | number): string =>
  (typeof value === "string" ? BigInt(value) : BigInt(value))
    .toString(16)
    .padStart(64, "0");
export const topicAddress = (a: string) => `0x${word(a)}`;

export interface BackingChain {
  /** Every transaction the page's wallet sent, newest last. */
  sent: { to: string; data: string; from: string }[];
  /** Every `eth_call` selector asked of the factory, so a spec can say the factory was or was not asked. */
  asked: string[];
  /** Replace the pool (null for no pool at all); the next read sees it. */
  setPool: (pool: PoolFixture | null) => void;
}

const SELECTORS = {
  poolOf: selectorOf("poolOf(address)"),
  factoryQuote: selectorOf("quote()"),
  founderOf: selectorOf("founderOf(address)"),
  auctionFactory: selectorOf("auctionFactory()"),
  defaultMinimum: selectorOf("defaultMinimumRaise()"),
  floor: selectorOf("roundFloorPriceX96()"),
  tick: selectorOf("roundTickSpacingX96()"),
  snapshot: selectorOf("snapshot(address)"),
  founder: selectorOf("founder()"),
  quoteBuy: selectorOf("quoteBuy(uint256)"),
  quoteSell: selectorOf("quoteSell(address,uint256)"),
  quoteLeave: selectorOf("quoteLeave(address)"),
  decimals: selectorOf("decimals()"),
  symbol: selectorOf("symbol()"),
  balanceOf: selectorOf("balanceOf(address)"),
  allowance: selectorOf("allowance(address,address)"),
};

/** The 47 words `snapshot(address)` answers, from a fixture. */
export function snapshotFor(pool: PoolFixture, now: number): string {
  const roundState = {
    live: 2n,
    waiting: 1n,
    failed: 3n,
    abandoned: 2n,
    "no-round": 0n,
  }[pool.phase];
  const open = pool.windowEndsIn !== null;
  const ends = BigInt(now + (pool.windowEndsIn ?? 0));
  const milestone = [
    open ? `0x${pool.milestoneRef}` : `0x${"00".repeat(32)}`,
    open ? BigInt(now - 3 * 86_400) : 0n,
    open ? ends : 0n,
    open ? ends + 7n * 86_400n : 0n,
    open ? 1n : 0n,
    open ? pool.escrow : 0n,
    0n,
    0n,
  ];
  const round = [
    roundState,
    FIXTURE.auction,
    FIXTURE.claim,
    100_000_000n * E18,
    BigInt(1_000 + pool.roundBlocksLeft),
    pool.roundMinimum,
    pool.roundRaised,
    FLOOR_X96,
    0n,
    0n,
    0n,
    0n,
    0n,
    pool.holderClaimTokens,
  ];
  return encodeParameters(
    [BACKING_STRUCT_TYPES.Snapshot],
    [
      [
        (25n * ONE * E18) / 1_000_000n, // price: 0.000025 whole quote per unit, in the fixed point
        (28n * ONE * E18) / 1_000_000n,
        pool.reserve,
        pool.escrow,
        pool.released,
        0n,
        25n * ONE,
        0n,
        80_000_000n * E18,
        pool.escrow * 10n ** 12n,
        pool.phase === "abandoned",
        BigInt(now - 40 * 86_400),
        BigInt(now + pool.nextClaimIn),
        BigInt(now + 140 * 86_400),
        0n,
        open ? 1n : pool.released > 0n ? 1n : 0n,
        milestone,
        open ? pool.escrow / 4n : 0n,
        pool.holderUnits,
        pool.holderUnits === 0n ? 0n : 5n * 10n ** 12n,
        pool.holderEscrow,
        pool.holderSellValue,
        pool.holderCanLeave,
        pool.holderLeaveValue,
        false,
        pool.holderEarlyLeft ?? MAX,
        round,
      ],
    ],
  );
}

/** A `Bought` log as the pool emits it. */
export function boughtEvent(
  buyer: string,
  quoteIn: bigint,
  priceAfter: bigint,
  block: number,
) {
  return {
    topics: [BACKING_TOPICS.bought, topicAddress(buyer)],
    data: encodeParameters(Array(7).fill("uint256"), [
      quoteIn,
      quoteIn * 30n,
      quoteIn / 100n,
      quoteIn / 11n,
      priceAfter,
      5n,
      6n,
    ]),
    block,
  };
}

export function postedEvent(
  id: bigint,
  ref: string,
  by: string,
  block: number,
) {
  return {
    topics: [
      BACKING_TOPICS.milestonePosted,
      `0x${word(id)}`,
      `0x${ref}`,
      topicAddress(by),
    ],
    data: encodeParameters(Array(4).fill("uint256"), [
      BigInt(Math.floor(Date.now() / 1000) + 5 * 86_400),
      BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
      220n * ONE,
      55n * ONE,
    ]),
    block,
  };
}

export function resolvedEvent(
  id: bigint,
  released: boolean,
  amount: bigint,
  block: number,
) {
  return {
    topics: [BACKING_TOPICS.milestoneResolved, `0x${word(id)}`],
    data: encodeParameters(["bool", "uint256"], [released, amount]),
    block,
  };
}

/**
 * Serve the fixture at `/test-rpc` and point the page's chain reads at it. `wallet` (when given) installs a
 * `window.ethereum` that answers as that account and records what it is asked to send instead of sending it.
 */
export async function installBackingChain(
  page: Page,
  options: {
    pool: PoolFixture | null;
    /** The DAO the kit launched; null for a project whose start no kit confirms. */
    kitMadeDao?: string | null;
    wallet?: string | null;
    founder?: string;
    /** Give the founder no wallet on record (a project from the older kit). */
    noFounder?: boolean;
    roundsOffered?: boolean;
    /** Make the node refuse every read until this is set again. */
    down?: boolean;
  },
): Promise<BackingChain & { setDown: (down: boolean) => void }> {
  const state = {
    pool: options.pool,
    down: options.down ?? false,
  };
  const sent: BackingChain["sent"] = [];
  const asked: string[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  const kitDao =
    options.kitMadeDao === undefined ? FIXTURE.dao : options.kitMadeDao;

  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  });
  if (options.wallet) {
    await page.addInitScript(
      ({ account, chainId }) => {
        const sentCalls: unknown[] = [];
        (window as unknown as { __sent: unknown[] }).__sent = sentCalls;
        Object.defineProperty(window, "ethereum", {
          configurable: true,
          value: {
            request: async ({
              method,
              params,
            }: {
              method: string;
              params?: unknown[];
            }) => {
              if (method === "eth_requestAccounts" || method === "eth_accounts")
                return [account];
              if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
              if (method === "eth_sendTransaction") {
                sentCalls.push((params ?? [])[0]);
                // Reported to the spec through the page route below.
                await fetch("/__sent", {
                  method: "POST",
                  body: JSON.stringify((params ?? [])[0]),
                });
                return `0x${sentCalls.length.toString(16).padStart(64, "a")}`;
              }
              if (method === "eth_getTransactionReceipt")
                return {
                  status: "0x1",
                  transactionHash: (params ?? [])[0],
                  blockNumber: "0x10",
                  logs: [],
                };
              if (method === "wallet_switchEthereumChain") return null;
              const res = await fetch("/test-rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  params: params ?? [],
                }),
              });
              const body = await res.json();
              if (body.error)
                throw { code: body.error.code, message: body.error.message };
              return body.result;
            },
            on() {},
            removeListener() {},
          },
        });
      },
      { account: options.wallet, chainId: FIXTURE.chainId },
    );
    await page.route("**/__sent", async (route) => {
      const call = JSON.parse(route.request().postData() ?? "{}") as {
        to: string;
        data: string;
        from: string;
      };
      sent.push({
        to: call.to.toLowerCase(),
        data: call.data,
        from: call.from,
      });
      await route.fulfill({ status: 200, body: "{}" });
    });
  }

  await page.route("**/test-rpc", async (route) => {
    const { id, method, params } = JSON.parse(
      route.request().postData() ?? "{}",
    ) as {
      id: number;
      method: string;
      params: Record<string, unknown>[];
    };
    const reply = (body: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
      });
    if (state.down) return route.abort("connectionrefused");
    const ok = (hex: string) => reply({ result: hex });
    const w = (v: bigint | string | number) => `0x${word(v)}`;
    if (method === "eth_chainId")
      return ok(`0x${FIXTURE.chainId.toString(16)}`);
    if (method === "eth_blockNumber") return ok("0x3e8");
    if (method === "eth_getBlockByNumber")
      return reply({
        result: {
          number: String(params[0]),
          timestamp: `0x${now().toString(16)}`,
        },
      });
    if (method === "eth_estimateGas") return ok("0x30d40");
    if (method === "eth_getLogs") {
      const filter = params[0] as {
        address?: string;
        topics?: (string | string[] | null)[];
      };
      const address = String(filter.address ?? "").toLowerCase();
      if (
        address === FIXTURE.kit &&
        kitDao &&
        filter.topics?.[2] === topicAddress(kitDao)
      ) {
        return reply({
          result: [
            {
              address: FIXTURE.kit,
              topics: [
                filter.topics[0],
                w(FIXTURE.founderWallet),
                topicAddress(kitDao),
              ],
              data: "0x",
              blockNumber: "0x5",
              transactionHash: `0x${"cd".repeat(32)}`,
              logIndex: "0x0",
            },
          ],
        });
      }
      if (address === FIXTURE.pool && state.pool) {
        return reply({
          result: state.pool.events.map((event, index) => ({
            address: FIXTURE.pool,
            topics: event.topics,
            data: event.data,
            blockNumber: `0x${event.block.toString(16)}`,
            transactionHash: `0x${"ab".repeat(32)}`,
            logIndex: `0x${index.toString(16)}`,
          })),
        });
      }
      return reply({ result: [] });
    }
    if (method !== "eth_call")
      return reply({ error: { code: -32601, message: `no ${method}` } });

    const call = params[0] as { to: string; data: string };
    const to = call.to.toLowerCase();
    const data = call.data;
    const selector = data.slice(0, 10);
    if (to === FIXTURE.factory) {
      asked.push(selector);
      if (selector === SELECTORS.poolOf)
        return ok(w(state.pool ? FIXTURE.pool : 0n));
      if (selector === SELECTORS.factoryQuote) return ok(w(FIXTURE.token));
      if (selector === SELECTORS.founderOf)
        return ok(
          w(
            options.noFounder ? 0n : (options.founder ?? FIXTURE.founderWallet),
          ),
        );
      if (selector === SELECTORS.auctionFactory)
        return ok(
          w(options.roundsOffered === false ? 0n : `0x${"af".repeat(20)}`),
        );
      if (selector === SELECTORS.defaultMinimum) return ok(w(2_500n * ONE));
      if (selector === SELECTORS.floor) return ok(w(FLOOR_X96));
      if (selector === SELECTORS.tick) return ok(w(TICK_X96));
    }
    if (to === FIXTURE.pool && state.pool) {
      if (selector === SELECTORS.snapshot)
        return ok(snapshotFor(state.pool, now()));
      if (selector === SELECTORS.founder)
        return ok(
          w(
            options.noFounder ? 0n : (options.founder ?? FIXTURE.founderWallet),
          ),
        );
      if (selector === SELECTORS.factoryQuote) return ok(w(FIXTURE.token));
      if (selector === SELECTORS.quoteBuy) {
        const quoteIn = BigInt(`0x${data.slice(10, 74)}`);
        return ok(
          `0x${[quoteIn * 30n, quoteIn / 100n, quoteIn / 11n, (26n * ONE * E18) / 1_000_000n].map(word).join("")}`,
        );
      }
      if (selector === SELECTORS.quoteSell) {
        const units = BigInt(`0x${data.slice(74, 138)}`);
        const out = (((units * 25n * ONE) / (1_000_000n * E18)) * E18) / E18;
        return ok(
          `0x${[state.pool.holderSellValue ? (state.pool.holderSellValue * units) / state.pool.holderUnits : out, 1n, 0n, 1n].map(word).join("")}`,
        );
      }
      if (selector === SELECTORS.quoteLeave) {
        return ok(
          `0x${[
            state.pool.holderLeaveValue,
            state.pool.holderLeaveValue - state.pool.holderEscrow,
            state.pool.holderEscrow,
            1n,
            1n,
          ]
            .map(word)
            .join("")}`,
        );
      }
    }
    if (to === FIXTURE.auction) {
      // The sale's own reads, as "My bids" makes them: not graduated yet, no bids.
      if (selector === "0x9e5f2602") return ok(w(0n));
      if (selector === "0x32a0f2d7") return ok(w(FLOOR_X96));
      if (selector === "0x083c6323") return ok(w(1_000n));
      if (selector === "0x37dfbc4b") return ok(w(1_000n));
    }
    if (to === FIXTURE.token) {
      if (selector === SELECTORS.decimals) return ok(w(QUOTE_DECIMALS));
      if (selector === SELECTORS.symbol)
        return ok(encodeParameters(["string"], ["tTEST"]));
      if (selector === SELECTORS.balanceOf) return ok(w(5_000n * ONE));
      if (selector === SELECTORS.allowance) return ok(w(0n));
    }
    return reply({
      error: { code: -32000, message: `not stubbed: ${to} ${selector}` },
    });
  });

  return {
    sent,
    asked,
    setPool: (next) => {
      state.pool = next;
    },
    setDown: (down) => {
      state.down = down;
    },
  };
}
