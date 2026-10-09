/**
 * The decision that puts a DAO's Shares on the Limit Break AMM, composed for a form (the same decision the command
 * line's `buzz launchpad market seed` composes, with the same numbers: `marketActions.test.mjs` pins both to the
 * pool shapes the Rust implementation produces).
 *
 * One batch the DAO runs as itself: keep the AMM's Shares out of the voting supply, name the AMM's standard hook as the
 * Shares' hook, set that hook's fee on the paired currency, approve the AMM, create a dynamic-price pool and seed it with
 * Shares only, from the starting price upward. The DAO needs no currency to start; it sells into demand as the price rises.
 *
 * The AMM is evaluation-only software (see `docs/v3-review/LBAMM.md`); this composes calldata for contracts the caller
 * deployed locally and contains none of its code.
 */

import { encodeFunctionData, type AbiType, type AbiValue } from "./evmAbi.ts";
import {
  DecisionInputError,
  encodeBatch,
  formatUnits,
  parseUnits,
  type DecisionDraft,
} from "./daoActions.ts";

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const MAX_TICK_SPACING = 16_384;
/** The most a fee on the paired currency may be: 10%. */
export const MAX_TAX_BPS = 1_000;
/** Before, after a swap, when liquidity is added and when a pool is created. */
const HOOK_FLAGS = 1n | 2n | 4n | 32n;
const ZERO = `0x${"0".repeat(40)}`;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const Q96 = 1n << 96n;

export const MARKET_SIGNATURES = {
  setExcluded: "setExcluded(address,bool)",
  approve: "approve(address,uint256)",
  ammSetToken: "setTokenSettings(address,address,uint32)",
  hookSetToken:
    "setTokenSettings(address,(bool,bool,bool,bool,uint16,uint16,uint16,uint16,uint16,uint16,uint56,uint56,uint56),bytes32[],bytes[],bytes32[],bytes32[],address[])",
  createPool:
    "createPool((address,uint16,address,address,address,bytes),bytes,bytes,bytes,bytes)",
  addLiquidity:
    "addLiquidity((address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,bytes),(bytes,bytes,bytes,bytes))",
  computePoolId:
    "computePoolId((address,uint16,address,address,address,bytes))",
  singleSwap:
    "singleSwap((uint256,address,int256,uint256,uint256,address,address),bytes32,(address,uint256),(address,uint256),(bytes,bytes,bytes,bytes),bytes)",
  hookFeesOwed: "getHookFeesOwedByToken(address,address)",
} as const;

const DETAILS_TYPE: AbiType = {
  tuple: ["address", "uint16", "address", "address", "address", "bytes"],
};
const POOL_PARAMS_TYPES: AbiType[] = ["int24", "uint160"];
const LIQUIDITY_PARAMS_TYPES: AbiType[] = [
  "int24",
  "int24",
  "int128",
  "uint160",
];

function fail(field: string, message: string): never {
  throw new DecisionInputError(field, message);
}

// ---- price and tick maths ------------------------------------------------------------------

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

let BASE_Q256: bigint | null = null;

/** `sqrt(1.0001^tick)` as a Q64.96 number, computed in 256-bit fixed point and rounded up. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK)
    fail("price", `That price is outside what a pool can hold (tick ${tick}).`);
  BASE_Q256 ??= isqrt((10_001n << 512n) / 10_000n);
  const mul = (a: bigint, b: bigint) => (a * b) >> 256n;
  let ratio = 1n << 256n;
  let power = BASE_Q256;
  let bits = Math.abs(tick);
  while (bits > 0) {
    if (bits & 1) ratio = mul(ratio, power);
    power = mul(power, power);
    bits = Math.floor(bits / 2);
  }
  if (tick < 0) ratio = (1n << 512n) / ratio;
  return (ratio + ((1n << 160n) - 1n)) >> 160n;
}

function nearestTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0)
    fail("price", "The price must be above zero.");
  const tick = Math.round(Math.log(price) / Math.log(1.0001));
  if (tick < MIN_TICK || tick > MAX_TICK)
    fail("price", "That price is outside what a pool can hold.");
  return tick;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const alignNearest = (tick: number, spacing: number) =>
  floorDiv(tick + Math.floor(spacing / 2), spacing) * spacing;
const alignUp = (tick: number, spacing: number) =>
  -floorDiv(-tick, spacing) * spacing;
const alignDown = (tick: number, spacing: number) =>
  floorDiv(tick, spacing) * spacing;

/** The pool the decision creates, worked out from its terms. */
export interface PoolShape {
  sharesAreToken0: boolean;
  startTick: number;
  /** The pool's starting price: one tick short of the first position, so the pool never straddles it. */
  initSqrtPrice: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/**
 * Shares only, from the starting price in the direction the price moves as people buy. `priceRaw` is currency base units
 * per Share base unit. Liquidity is rounded down by one part in a billion so a deposit can never exceed the Shares
 * the vote approved.
 */
export function poolShape(
  sharesAreToken0: boolean,
  priceRaw: number,
  spacing: number,
  sharesAmount: bigint,
): PoolShape {
  if (!Number.isInteger(spacing) || spacing < 1 || spacing > MAX_TICK_SPACING)
    fail("tickSpacing", `The price step is 1 to ${MAX_TICK_SPACING} ticks.`);
  // The pool's price is token1 per token0: currency per Share when the Shares sort first, Shares per currency otherwise.
  const poolPrice = sharesAreToken0 ? priceRaw : 1 / priceRaw;
  const startTick = alignNearest(nearestTick(poolPrice), spacing);
  const [tickLower, tickUpper, initTick] = sharesAreToken0
    ? [startTick, alignDown(MAX_TICK, spacing), startTick - 1]
    : [alignUp(MIN_TICK, spacing), startTick, startTick + 1];
  if (tickLower >= tickUpper)
    fail(
      "price",
      "That price leaves no room for liquidity; pick a price the pool can hold.",
    );
  const a = sqrtPriceAtTick(tickLower);
  const b = sqrtPriceAtTick(tickUpper);
  const span = b - a;
  const raw = sharesAreToken0
    ? (sharesAmount * ((a * b) / Q96)) / span
    : (sharesAmount * Q96) / span;
  const liquidity = raw - raw / 1_000_000_000n;
  if (liquidity === 0n)
    fail("shares", "That amount of Shares is too small to seed.");
  if (liquidity >= 1n << 127n)
    fail("shares", "That much liquidity does not fit the pool.");
  return {
    sharesAreToken0,
    startTick,
    initSqrtPrice: sqrtPriceAtTick(initTick),
    tickLower,
    tickUpper,
    liquidity,
  };
}

// ---- the decision -------------------------------------------------------------------------------

export interface MarketTerms {
  /** Contracts the batch calls. */
  policy: string;
  sharesToken: string;
  currency: string;
  amm: string;
  hook: string;
  registry: string;
  poolType: string;
  /** Base units of Shares to seed from the DAO's own balance. */
  sharesAmount: bigint;
  shape: PoolShape;
  poolFeeBps: number;
  taxBps: number;
  tickSpacing: number;
}

function address(value: string, field: string, what: string): string {
  if (!ADDRESS_RE.test(value.trim())) fail(field, `${what} is not an address.`);
  return value.trim().toLowerCase();
}

/** The pool's creation details, as the AMM and the pool type take them. */
export function poolDetails(terms: MarketTerms): AbiValue[] {
  const shares = terms.sharesToken.toLowerCase();
  const currency = terms.currency.toLowerCase();
  const [token0, token1] = terms.shape.sharesAreToken0
    ? [shares, currency]
    : [currency, shares];
  const params = encodeFunctionData("f(int24,uint160)", POOL_PARAMS_TYPES, [
    BigInt(terms.tickSpacing),
    terms.shape.initSqrtPrice,
  ]).slice(10);
  return [
    terms.poolType,
    BigInt(terms.poolFeeBps),
    token0,
    token1,
    ZERO,
    `0x${params}`,
  ];
}

/** `computePoolId(details)` as an eth_call: the pool type's own name for the pool these terms create. */
export function computePoolIdCall(terms: MarketTerms): string {
  return encodeFunctionData(
    MARKET_SIGNATURES.computePoolId,
    [DETAILS_TYPE],
    [poolDetails(terms)],
  );
}

/** The six calls the DAO makes, in the order that works. `poolId` is the pool type's answer for these terms. */
export function marketCalls(
  terms: MarketTerms,
  poolId: string,
): { to: string; data: string }[] {
  const { shape } = terms;
  const sharesSide = shape.sharesAreToken0;
  const hookSettings: AbiValue = [
    true,
    false,
    true,
    false,
    0n,
    0n,
    BigInt(terms.taxBps),
    BigInt(terms.taxBps),
    0n,
    10_000n,
    0n,
    0n,
    0n,
  ];
  const noBytes: AbiValue[] = ["0x", "0x", "0x", "0x"];
  const liquidityParams = encodeFunctionData(
    "f(int24,int24,int128,uint160)",
    LIQUIDITY_PARAMS_TYPES,
    [BigInt(shape.tickLower), BigInt(shape.tickUpper), shape.liquidity, 0n],
  ).slice(10);
  return [
    {
      to: terms.policy,
      data: encodeFunctionData(
        MARKET_SIGNATURES.setExcluded,
        ["address", "bool"],
        [terms.amm, true],
      ),
    },
    {
      to: terms.amm,
      data: encodeFunctionData(
        MARKET_SIGNATURES.ammSetToken,
        ["address", "address", "uint32"],
        [terms.sharesToken, terms.hook, HOOK_FLAGS],
      ),
    },
    {
      to: terms.registry,
      data: encodeFunctionData(
        MARKET_SIGNATURES.hookSetToken,
        [
          "address",
          {
            tuple: [
              "bool",
              "bool",
              "bool",
              "bool",
              "uint16",
              "uint16",
              "uint16",
              "uint16",
              "uint16",
              "uint16",
              "uint56",
              "uint56",
              "uint56",
            ],
          },
          { array: "bytes32" },
          { array: "bytes" },
          { array: "bytes32" },
          { array: "bytes32" },
          { array: "address" },
        ],
        [terms.sharesToken, hookSettings, [], [], [], [], [terms.hook]],
      ),
    },
    {
      to: terms.sharesToken,
      data: encodeFunctionData(
        MARKET_SIGNATURES.approve,
        ["address", "uint256"],
        [terms.amm, terms.sharesAmount],
      ),
    },
    {
      to: terms.amm,
      data: encodeFunctionData(
        MARKET_SIGNATURES.createPool,
        [DETAILS_TYPE, "bytes", "bytes", "bytes", "bytes"],
        [poolDetails(terms), "0x", "0x", "0x", "0x"],
      ),
    },
    {
      to: terms.amm,
      data: encodeFunctionData(
        MARKET_SIGNATURES.addLiquidity,
        [
          {
            tuple: [
              "address",
              "bytes32",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
              "bytes",
            ],
          },
          { tuple: ["bytes", "bytes", "bytes", "bytes"] },
        ],
        [
          [
            ZERO,
            poolId,
            0n,
            0n,
            sharesSide ? terms.sharesAmount : 0n,
            sharesSide ? 0n : terms.sharesAmount,
            0n,
            0n,
            `0x${liquidityParams}`,
          ],
          noBytes,
        ],
      ),
    },
  ];
}

export interface MarketInput {
  dao: string;
  policy: string;
  sharesToken: string;
  currency: string;
  currencyDecimals: number;
  amm: string;
  hook: string;
  registry: string;
  poolType: string;
  /** Whole Shares and the starting price in whole currency per Share, as typed. */
  shares: string;
  price: string;
  poolFeeBps: number;
  taxBps: number;
  tickSpacing: number;
}

/** What the terms mean, before the pool's id is known: enough to ask the pool type for the id. */
export function marketTerms(input: MarketInput): MarketTerms {
  const sharesAmount = parseUnits(input.shares, 18, "shares", "The Shares");
  if (sharesAmount === 0n)
    fail("shares", "Put at least some Shares on the market.");
  if (sharesAmount >= 1n << 128n) fail("shares", "That amount is too large.");
  if (
    !Number.isInteger(input.poolFeeBps) ||
    input.poolFeeBps < 1 ||
    input.poolFeeBps > 10_000
  )
    fail("poolFeeBps", "The pool's fee is between 0.01% and 100%.");
  if (
    !Number.isInteger(input.taxBps) ||
    input.taxBps < 0 ||
    input.taxBps > MAX_TAX_BPS
  )
    fail("taxBps", `The fee on every trade is at most ${MAX_TAX_BPS / 100}%.`);
  const priceUnits = parseUnits(
    input.price,
    input.currencyDecimals,
    "price",
    "The price",
  );
  if (priceUnits === 0n) fail("price", "The price must be above zero.");
  const sharesToken = address(input.sharesToken, "shares", "The Shares");
  const currency = address(input.currency, "currency", "The currency");
  if (sharesToken === currency)
    fail("currency", "The currency cannot be the Shares themselves.");
  return {
    policy: address(input.policy, "policy", "The voting policy"),
    sharesToken,
    currency,
    amm: address(input.amm, "amm", "The exchange"),
    hook: address(input.hook, "hook", "The exchange's fee hook"),
    registry: address(input.registry, "registry", "The fee settings"),
    poolType: address(input.poolType, "poolType", "The pool type"),
    sharesAmount,
    // Currency base units per Share base unit; a float is enough to choose a starting price step.
    shape: poolShape(
      sharesToken < currency,
      Number(priceUnits) / 1e18,
      input.tickSpacing,
      sharesAmount,
    ),
    poolFeeBps: input.poolFeeBps,
    taxBps: input.taxBps,
    tickSpacing: input.tickSpacing,
  };
}

/** The decision itself, once the pool type has named the pool. */
export function marketDecision(
  input: MarketInput,
  poolId: string,
): DecisionDraft {
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId))
    fail("poolId", "The exchange has not named the pool yet.");
  const terms = marketTerms(input);
  const sharesLabel = formatUnits(terms.sharesAmount, 18);
  return {
    to: input.dao.toLowerCase(),
    data: encodeBatch(marketCalls(terms, poolId)),
    lane: "unrestricted",
    title: `Put ${sharesLabel} Shares on the market`,
    lines: [
      `Starting price about ${input.price.trim()} per Share, rising as people buy`,
      `A ${terms.taxBps / 100}% fee on every trade goes to the DAO`,
      `The pool takes a ${terms.poolFeeBps / 100}% fee for those who provide the Shares`,
      "The Shares come from the DAO's own balance; it needs no money to start",
    ],
  };
}

/**
 * `AMM.singleSwap(...)` for an exact amount paid in, received by `recipient`, with no fee on top. `minOut` is the least
 * the trader accepts back in the token they receive: the swap reverts rather than give less.
 */
export function encodeSwap(input: {
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  deadline: number;
  poolId: string;
}): string {
  if (input.amountIn <= 0n) fail("amount", "Trade more than nothing.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.poolId))
    fail("poolId", "There is no pool to trade in.");
  const noFee: AbiValue = [ZERO, 0n];
  return encodeFunctionData(
    MARKET_SIGNATURES.singleSwap,
    [
      {
        tuple: [
          "uint256",
          "address",
          "int256",
          "uint256",
          "uint256",
          "address",
          "address",
        ],
      },
      "bytes32",
      { tuple: ["address", "uint256"] },
      { tuple: ["address", "uint256"] },
      { tuple: ["bytes", "bytes", "bytes", "bytes"] },
      "bytes",
    ],
    [
      [
        BigInt(input.deadline),
        address(input.recipient, "recipient", "The recipient"),
        input.amountIn,
        0n,
        input.minOut,
        address(input.tokenIn, "tokenIn", "The token paid"),
        address(input.tokenOut, "tokenOut", "The token received"),
      ],
      input.poolId,
      noFee,
      noFee,
      ["0x", "0x", "0x", "0x"],
      "0x",
    ],
  );
}
