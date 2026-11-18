/**
 * The market side of a project's numbers (kind 39009): its Pair, its Finisher, the one auction (`sale`), the bids'
 * totals per auction (never who bid), the pool's trades and the earlier backers' counts. Kept apart from `numbers.ts` so
 * each file stays readable; `parseNumbers` calls `parseMarket` on the same checked record. Pure.
 */

export interface SaleNumbers {
  auction: string;
  /** The least the auction must raise, in raw dollars, or it refunds every bid in full. */
  minimum: bigint;
  startBlock: number;
  endBlock: number;
  /** The starting (floor) price, raw dollars per raw Share times 2^96. */
  floorPriceQ96: bigint;
  tickSpacingQ96: bigint;
  openedAt: number | null;
  settled: { raised: bigint; afterFee: bigint; toTreasury: bigint } | null;
  pool: {
    poolId: string;
    sqrtPriceX96: bigint;
    poolDollars: bigint;
    poolShares: bigint;
  } | null;
  abandonedAt: number | null;
}

export interface BidTotals {
  auction: string;
  count: number;
  amount: bigint;
  clearingPriceQ96: bigint | null;
}

export interface MarketNumbers {
  finisher: string | null;
  /** The project's Pair, once a second person accepted; null before. */
  pair: string | null;
  sale: SaleNumbers | null;
  bids: BidTotals[];
  pool: { trades: number; sqrtPriceX96: bigint | null };
  woundDownAt: number | null;
  /** Project zero's earlier backers' claim contract, when the record names one. */
  earlierClaim: string | null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function big(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v);
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) return null;
  return BigInt(v);
}
function int(v: unknown): number | null {
  const b = big(v);
  return b !== null && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
}
function address(v: unknown): string | null {
  return typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : null;
}

function parseSale(s: unknown): SaleNumbers | null {
  if (!isObject(s)) return null;
  const auction = address(s.auction);
  const minimum = big(s.minimum);
  const startBlock = int(s.startBlock);
  const endBlock = int(s.endBlock);
  const floor = big(s.floorPriceQ96);
  const tick = big(s.tickSpacingQ96);
  if (!auction || minimum === null || startBlock === null || endBlock === null)
    return null;
  if (floor === null || tick === null) return null;
  const settled = isObject(s.settled) ? s.settled : null;
  const pool = isObject(s.pool) ? s.pool : null;
  const raised = settled ? big(settled.raised) : null;
  const sqrt = pool ? big(pool.sqrtPriceX96) : null;
  return {
    auction,
    minimum,
    startBlock,
    endBlock,
    floorPriceQ96: floor,
    tickSpacingQ96: tick,
    openedAt: int(s.openedAt),
    settled:
      settled && raised !== null
        ? {
            raised,
            afterFee: big(settled.afterFee) ?? 0n,
            toTreasury: big(settled.toTreasury) ?? 0n,
          }
        : null,
    pool:
      pool &&
      sqrt !== null &&
      typeof pool.poolId === "string" &&
      HEX32.test(pool.poolId)
        ? {
            poolId: pool.poolId.toLowerCase(),
            sqrtPriceX96: sqrt,
            poolDollars: big(pool.poolDollars) ?? 0n,
            poolShares: big(pool.poolShares) ?? 0n,
          }
        : null,
    abandonedAt: int(s.abandonedAt),
  };
}

/** The market fields of a checked record's body. Anything missing or malformed reads as "none". */
export function parseMarket(body: Json): MarketNumbers {
  const contracts = isObject(body.contracts) ? body.contracts : {};
  const pool = isObject(body.pool) ? body.pool : {};
  const earlier = isObject(body.earlierBackers) ? body.earlierBackers : null;
  const bids = Array.isArray(body.bids) ? body.bids.filter(isObject) : [];
  return {
    finisher: address(contracts.finisher),
    pair: address(contracts.pair),
    sale: parseSale(body.sale),
    bids: bids.flatMap((b) => {
      const auction = address(b.auction);
      if (!auction) return [];
      return [
        {
          auction,
          count: int(b.count) ?? 0,
          amount: big(b.amount) ?? 0n,
          clearingPriceQ96: big(b.clearingPriceQ96),
        },
      ];
    }),
    pool: {
      trades: int(pool.trades) ?? 0,
      sqrtPriceX96: big(pool.sqrtPriceX96),
    },
    woundDownAt: int(body.woundDownAt),
    earlierClaim: earlier ? address(earlier.claim) : null,
  };
}

/** Where the auction is at block `block`: not opened, taking bids, closed to bids (its last 720 blocks), or ended. */
export function auctionState(
  sale: SaleNumbers | null,
  block: number,
): "none" | "bidding" | "closing" | "ended" {
  if (!sale || sale.abandonedAt !== null) return "none";
  if (block >= sale.endBlock) return "ended";
  return block + BID_CLOSING_BLOCKS > sale.endBlock ? "closing" : "bidding";
}

/** No bids in the last 720 blocks of a sale (`MinBid.closingBlocks`). */
export const BID_CLOSING_BLOCKS = 720;
