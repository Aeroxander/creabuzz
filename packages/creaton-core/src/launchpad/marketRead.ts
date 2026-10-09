/**
 * Reading a project's market from the chain, and sizing a trade in it: which pool trades the Shares against the sale's
 * currency, what it is trading at, and what a trade of a given size should return. Nothing here needs the price service
 * (it reads the exchange itself), and the chain is injected so `marketRead.test.mjs` runs the real reader against a fake.
 *
 * A quote is an estimate from the pool's current price and its fees, not a promise: a large trade moves the price, so the
 * caller sets how much worse than the estimate it will accept, and the exchange reverts a trade that would give less.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { encodeFunctionData } from "./evmAbi.ts";
import { wholePrice } from "./marketFeed.ts";
import { decodeWord } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

export const TOPIC_POOL_CREATED = `0x${bytesToHex(
  keccak_256(
    utf8ToBytes("PoolCreated(address,address,address,bytes32,address)"),
  ),
)}`;
const SIGNATURE_PRICE = "getCurrentPriceX96(address,bytes32)";

/** The most pools read for one project's pair (there is normally one). */
const MAX_POOLS = 8;
const Q96 = 2 ** 96;

export interface MarketPool {
  /** The pool's id: `0x` + 64 hex. */
  id: string;
  poolType: string;
  sharesAreToken0: boolean;
  /** The pool's own fee in basis points; the pool's id carries it. */
  feeBps: number;
}

const topicOfAddress = (a: string) =>
  `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

/**
 * The pool that trades exactly the Shares against the sale currency on this exchange: the first one created if there are
 * several. Null when none exists yet.
 */
export async function findMarketPool(
  chain: Pick<WorkChain, "logs">,
  input: { amm: string; sharesToken: string; currency: string },
): Promise<MarketPool | null> {
  const shares = topicOfAddress(input.sharesToken);
  const currency = topicOfAddress(input.currency);
  const [sharesFirst, sharesSecond] = await Promise.all([
    chain.logs({
      address: input.amm,
      topics: [TOPIC_POOL_CREATED, null, shares, currency],
    }),
    chain.logs({
      address: input.amm,
      topics: [TOPIC_POOL_CREATED, null, currency, shares],
    }),
  ]);
  const read = (log: unknown, sharesAreToken0: boolean): MarketPool | null => {
    const l = log as { topics?: unknown; data?: unknown } | null;
    if (!l || !Array.isArray(l.topics) || typeof l.data !== "string")
      return null;
    const id = `0x${l.data.replace(/^0x/, "").slice(0, 64)}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
    const poolType = `0x${String(l.topics[1] ?? "").slice(-40)}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(poolType)) return null;
    // A pool's id carries its fee in its lowest two bytes.
    return {
      id: id.toLowerCase(),
      poolType: poolType.toLowerCase(),
      sharesAreToken0,
      feeBps: Number(BigInt(id) & 0xffffn),
    };
  };
  const pools = [
    ...sharesFirst.slice(0, MAX_POOLS).map((l) => read(l, true)),
    ...sharesSecond.slice(0, MAX_POOLS).map((l) => read(l, false)),
  ].filter((p): p is MarketPool => p !== null);
  return pools[0] ?? null;
}

/** The pool's current price in whole currency per whole Share, or null when it cannot be read. */
export async function readPoolPrice(
  chain: Pick<WorkChain, "call">,
  input: { amm: string; pool: MarketPool; currencyDecimals: number },
): Promise<number | null> {
  const hex = await chain.call(
    input.pool.poolType,
    encodeFunctionData(
      SIGNATURE_PRICE,
      ["address", "bytes32"],
      [input.amm, input.pool.id],
    ),
  );
  const sqrt = decodeWord(hex);
  if (sqrt === 0n) return null;
  const poolPrice = (Number(sqrt) / Q96) ** 2;
  return wholePrice(
    poolPrice,
    input.pool.sharesAreToken0,
    input.currencyDecimals,
  );
}

export type TradeSide = "buy" | "sell";

/**
 * About how much comes back for `amountIn` (base units of what is paid): at the current price, less the pool's fee and the
 * fee the DAO takes on every trade. A buy pays currency for Shares; a sell pays Shares for currency.
 */
export function estimateTrade(input: {
  side: TradeSide;
  amountIn: bigint;
  /** Whole currency per whole Share. */
  price: number;
  currencyDecimals: number;
  /** Total fees in basis points: the pool's and the DAO's. */
  feeBps: number;
}): bigint {
  if (!(input.price > 0) || input.amountIn <= 0n) return 0n;
  const keep = 1 - Math.min(input.feeBps, 10_000) / 10_000;
  const scale = 10 ** input.currencyDecimals;
  const out =
    input.side === "buy"
      ? (Number(input.amountIn) / scale / input.price) * 1e18 * keep
      : (Number(input.amountIn) / 1e18) * input.price * scale * keep;
  return Number.isFinite(out) && out > 0 ? BigInt(Math.floor(out)) : 0n;
}

/** The least to accept: the estimate less the slippage the person allows (0 to 50 percent). */
export function minimumOut(estimate: bigint, slippagePercent: number): bigint {
  const slip = Math.min(Math.max(slippagePercent, 0), 50);
  return (estimate * BigInt(Math.round((100 - slip) * 100))) / 10_000n;
}
