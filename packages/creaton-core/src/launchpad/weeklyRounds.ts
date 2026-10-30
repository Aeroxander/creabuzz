/**
 * Weekly rounds between a DAO's holders and new buyers (D131, `contracts/src/WeeklyRounds.sol`,
 * docs/v3-review/WEEKLY-ROUNDS.md): the calls, a round as the chain sees it, and the arithmetic the page shows before
 * anything is sent (which price step a price means, what a bid holds, what a seller keeps after the treasury's cut).
 *
 * Prices are in the round's currency per whole unit (18 decimals of Shares), in the currency's own units. Pure apart from
 * the reader, whose chain is injected (`weeklyRounds.test.mjs` runs it against a fake one); selectors are pinned to
 * `cast` in the same test.
 */

import { decodeParameters, encodeFunctionData } from "./evmAbi.ts";
import { addressTopic, decodeWord, topicOf } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;
const UNIT = 10n ** 18n;

export const BIDDING = 3 * DAY;
export const SETTLE_WINDOW = 2 * DAY;
export const EVERY = 7 * DAY;
export const STEPS = 1024;
export const CUT_BPS = 2000n;
export const DAO_MIN_STEPS = 2;
/** The most price steps the page lists, the busiest first. */
export const MAX_PRICE_ROWS = 12;

export const ROUND_SIGNATURES = {
  open: "open(address)",
  sell: "sell(uint256,uint256,uint256)",
  bid: "bid(uint256,uint256,uint256)",
  cancelSell: "cancelSell(uint256,address[])",
  cancelBid: "cancelBid(uint256)",
  settle: "settle(uint256,uint256)",
  claim: "claim(uint256,address)",
  claimAndLeave: "claimAndLeave(uint256,address[])",
  rounds: "rounds(uint256)",
  lastRound: "lastRound(address)",
  openFunding: "openFunding(address)",
  finishFunding: "finishFunding(uint256)",
  lastFunding: "lastFunding(address)",
  sells: "sells(uint256,address)",
  bids: "bids(uint256,address)",
  clearingStep: "clearingStep(uint256)",
  supplyAt: "supplyAt(uint256,uint256)",
  demandAt: "demandAt(uint256,uint256)",
  floorOf: "floorOf(address)",
} as const;

export const TOPIC_SELL_PLACED = topicOf(
  "SellPlaced(uint256,address,uint256,uint256)",
);
export const TOPIC_BID_PLACED = topicOf(
  "BidPlaced(uint256,address,uint256,uint256,uint256)",
);
/** Every round's opening, funding rounds' too: topic 1 is the round, topic 2 the DAO. */
export const TOPIC_ROUND_OPENED = topicOf(
  "RoundOpened(uint256,address,uint256,uint256,uint64)",
);

function assertAddress(value: string, what: string): string {
  if (!ADDRESS_RE.test(value)) throw new Error(`${what} is not an address`);
  return value;
}

function assertStep(step: number): number {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS) {
    throw new Error("that price is outside this round's steps");
  }
  return step;
}

function assertUnits(amount: bigint): bigint {
  if (amount <= 0n || amount >= 1n << 128n) {
    throw new Error("the amount must be above zero");
  }
  return amount;
}

// ---- calls ---------------------------------------------------------------------------------------

export function encodeOpenFundingRound(dao: string): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.openFunding,
    ["address"],
    [assertAddress(dao, "the DAO")],
  );
}

/** Finish a void funding round: its tranche goes back to the terms. */
export function encodeFinishFunding(id: bigint): string {
  return encodeFunctionData(ROUND_SIGNATURES.finishFunding, ["uint256"], [id]);
}

export function encodeOpenRound(dao: string): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.open,
    ["address"],
    [assertAddress(dao, "the DAO")],
  );
}

export function encodeSellInRound(
  id: bigint,
  amount: bigint,
  lowest: number,
): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.sell,
    ["uint256", "uint256", "uint256"],
    [id, assertUnits(amount), BigInt(assertStep(lowest))],
  );
}

export function encodeBidInRound(
  id: bigint,
  amount: bigint,
  highest: number,
): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.bid,
    ["uint256", "uint256", "uint256"],
    [id, assertUnits(amount), BigInt(assertStep(highest))],
  );
}

/** Take an offer back while bidding is open; with `leaveWith`, leave the DAO with those Shares instead. */
export function encodeCancelSell(
  id: bigint,
  leaveWith: readonly string[] = [],
): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.cancelSell,
    ["uint256", { array: "address" }],
    [id, leaveWith.map((t) => assertAddress(t, "a token"))],
  );
}

export function encodeCancelBid(id: bigint): string {
  return encodeFunctionData(ROUND_SIGNATURES.cancelBid, ["uint256"], [id]);
}

export function encodeSettleRound(id: bigint, step: number): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.settle,
    ["uint256", "uint256"],
    [id, BigInt(assertStep(step))],
  );
}

export function encodeClaimRound(id: bigint, who: string): string {
  return encodeFunctionData(
    ROUND_SIGNATURES.claim,
    ["uint256", "address"],
    [id, assertAddress(who, "the claimant")],
  );
}

/** Collect, leaving the DAO with the units you would collect: `leaveWith` sorted, as leaving asks. */
export function encodeClaimAndLeave(
  id: bigint,
  leaveWith: readonly string[],
): string {
  if (leaveWith.length === 0) throw new Error("name a token to leave with");
  return encodeFunctionData(
    ROUND_SIGNATURES.claimAndLeave,
    ["uint256", { array: "address" }],
    [id, leaveWith.map((t) => assertAddress(t, "a token"))],
  );
}

// ---- prices ----------------------------------------------------------------------------------------

export interface RoundGrid {
  /** Price per whole unit at step 0: what leaving paid when the round opened. */
  floor: bigint;
  /** Price per step. */
  step: bigint;
}

export const priceOfStep = (grid: RoundGrid, step: number): bigint =>
  grid.floor + BigInt(step) * grid.step;

/** The highest step at or below `price` (a buyer's limit), or null below the floor. */
export function stepAtMost(grid: RoundGrid, price: bigint): number | null {
  if (price < grid.floor || grid.step === 0n) return null;
  const step = (price - grid.floor) / grid.step;
  return Number(step >= BigInt(STEPS) ? BigInt(STEPS - 1) : step);
}

/** The lowest step at or above `price` (a seller's limit), or null above the last step. */
export function stepAtLeast(grid: RoundGrid, price: bigint): number | null {
  if (price <= grid.floor) return 0;
  if (grid.step === 0n) return null;
  const step = (price - grid.floor + grid.step - 1n) / grid.step;
  return step >= BigInt(STEPS) ? null : Number(step);
}

/** What a bid of `amount` units at `price` holds until the round is settled, as the contract rounds it. */
export function escrowFor(amount: bigint, price: bigint): bigint {
  const total = amount * price;
  return total === 0n ? 0n : (total - 1n) / UNIT + 1n;
}

/** What a seller keeps per whole unit at `price`: the price, less a fifth of the gain above the floor. */
export function sellerKeeps(grid: RoundGrid, price: bigint): bigint {
  return price - ((price - grid.floor) * CUT_BPS) / 10_000n;
}

// ---- reads -----------------------------------------------------------------------------------------

export type RoundPhase = "bidding" | "settling" | "settled" | "void";

export interface RoundOrder {
  amount: bigint;
  step: number;
  claimed: boolean;
}

export interface PriceRow {
  step: number;
  price: bigint;
  /** Units offered at this price or below. */
  offered: bigint;
  /** Units bid at this price or above. */
  wanted: bigint;
}

export interface RoundView extends RoundGrid {
  id: bigint;
  dao: string;
  shares: string;
  opensAt: number;
  closesAt: number;
  asked: bigint;
  wanted: bigint;
  settled: boolean;
  /** A funding round (D133): the DAO's tranche is the only offer; settling creates the units sold. */
  funding: boolean;
  /** A funding round whose tranche was settled or given back; a void one that isn't can be finished by anyone. */
  fundingDone: boolean;
  phase: RoundPhase;
  /**
   * The step it settled at, or would settle at if bidding ended now, what that trades, which side shares at it, and the
   * units offered one step below it and bid one step above it (what that side's share is worked out from).
   */
  clearing: {
    step: number;
    volume: bigint;
    sellersShare: boolean;
    offeredBelow: bigint;
    wantedAbove: bigint;
  };
  /** Steps that hold orders, lowest price first. */
  rows: PriceRow[];
  mine: { sell: RoundOrder | null; bid: RoundOrder | null };
}

export interface RoundsRead {
  /** The DAO's latest round, or null before its first. */
  round: RoundView | null;
  /** When the DAO's next round can open (unix seconds): now for a DAO with none yet. */
  nextOpensAt: number;
  /** What leaving pays per whole unit now, or null when nobody can leave. */
  floorNow: bigint | null;
}

export function roundPhase(
  r: { settled: boolean; closesAt: number },
  now: number,
): RoundPhase {
  if (r.settled) return "settled";
  if (now < r.closesAt) return "bidding";
  return now < r.closesAt + SETTLE_WINDOW ? "settling" : "void";
}

interface LogLike {
  topics?: unknown;
}

const words = (hex: string): bigint[] => {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return out;
};
const addressOf = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}`;

function decodeOrder(hex: string): RoundOrder | null {
  const [amount, step, claimed] = words(hex);
  if (!amount) return null;
  return { amount, step: Number(step), claimed: claimed !== 0n };
}

/** The steps the round's placed orders name, from their events (topic 1 is the round). */
export function orderSteps(logs: readonly unknown[]): number[] {
  const steps = new Set<number>();
  for (const raw of logs) {
    const log = raw as LogLike & { data?: unknown };
    if (typeof log.data !== "string") continue;
    // SellPlaced and BidPlaced both carry (amount, step, ...) first in their data.
    const [, step] = words(log.data);
    if (step !== undefined && step < BigInt(STEPS)) steps.add(Number(step));
  }
  return [...steps].sort((a, b) => a - b);
}

/**
 * A DAO's latest round between holders (or, with `which` "funding", its latest funding round), the price steps people
 * chose, and the connected wallet's orders.
 */
export async function readRounds(
  chain: Pick<WorkChain, "call" | "logs">,
  contract: string,
  dao: string,
  wallet: string | null,
  now: number,
  which: "holders" | "funding" = "holders",
): Promise<RoundsRead> {
  const at = assertAddress(contract, "the rounds contract");
  const daoAddress = assertAddress(dao, "the DAO");
  const latest =
    which === "funding"
      ? ROUND_SIGNATURES.lastFunding
      : ROUND_SIGNATURES.lastRound;
  const [last, floorHex] = await Promise.all([
    chain.call(at, encodeFunctionData(latest, ["address"], [daoAddress])),
    chain
      .call(
        at,
        encodeFunctionData(ROUND_SIGNATURES.floorOf, ["address"], [daoAddress]),
      )
      .catch(() => null),
  ]);
  const floorNow = floorHex === null ? null : decodeWord(floorHex);
  const id = decodeWord(last);
  if (id === 0n) return { round: null, nextOpensAt: now, floorNow };
  const id1 = (sig: string) => encodeFunctionData(sig, ["uint256"], [id]);
  const idTopic = `0x${id.toString(16).padStart(64, "0")}`;
  const [record, clearingHex, sellLogs, bidLogs, sellHex, bidHex] =
    await Promise.all([
      chain.call(at, id1(ROUND_SIGNATURES.rounds)),
      chain.call(at, id1(ROUND_SIGNATURES.clearingStep)),
      chain.logs({ address: at, topics: [TOPIC_SELL_PLACED, idTopic] }),
      chain.logs({ address: at, topics: [TOPIC_BID_PLACED, idTopic] }),
      wallet
        ? chain.call(
            at,
            encodeFunctionData(
              ROUND_SIGNATURES.sells,
              ["uint256", "address"],
              [id, wallet],
            ),
          )
        : Promise.resolve(null),
      wallet
        ? chain.call(
            at,
            encodeFunctionData(
              ROUND_SIGNATURES.bids,
              ["uint256", "address"],
              [id, wallet],
            ),
          )
        : Promise.resolve(null),
    ]);
  const w = words(record);
  const [settledWord, sellersShareWord, priceWord, volumeWord] = [
    w[8],
    w[9],
    w[10],
    w[11],
  ];
  const grid = { floor: w[4], step: w[5] };
  const settled = settledWord !== 0n;
  const closesAt = Number(w[3]);
  const [clearStep, clearVolume, clearSellersShare] = decodeParameters(
    ["uint256", "uint256", "bool"],
    clearingHex,
  ) as [bigint, bigint, boolean];
  const clearing = settled
    ? {
        step: Number(priceWord),
        volume: volumeWord,
        sellersShare: sellersShareWord !== 0n,
      }
    : {
        step: Number(clearStep),
        volume: clearVolume,
        sellersShare: clearSellersShare,
      };
  const at2 = (sig: string, step: number) =>
    chain
      .call(
        at,
        encodeFunctionData(sig, ["uint256", "uint256"], [id, BigInt(step)]),
      )
      .then(decodeWord);
  const [offeredBelow, wantedAbove] = await Promise.all([
    clearing.step === 0
      ? Promise.resolve(0n)
      : at2(ROUND_SIGNATURES.supplyAt, clearing.step - 1),
    clearing.step + 1 >= STEPS
      ? Promise.resolve(0n)
      : at2(ROUND_SIGNATURES.demandAt, clearing.step + 1),
  ]);
  // The steps people chose, and the clearing one, lowest price first, at most `MAX_PRICE_ROWS`.
  const steps = [
    ...new Set([...orderSteps([...sellLogs, ...bidLogs]), clearing.step]),
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX_PRICE_ROWS);
  const rows = (
    await Promise.all(
      steps.map(async (step) => {
        const [offered, wanted] = await Promise.all([
          at2(ROUND_SIGNATURES.supplyAt, step),
          at2(ROUND_SIGNATURES.demandAt, step),
        ]);
        return { step, price: priceOfStep(grid, step), offered, wanted };
      }),
    )
  ).filter((row) => row.offered > 0n || row.wanted > 0n);
  const opensAt = Number(w[2]);
  return {
    round: {
      id,
      dao: addressOf(w[0]),
      shares: addressOf(w[1]),
      opensAt,
      closesAt,
      ...grid,
      asked: w[6],
      wanted: w[7],
      settled,
      funding: (w[15] ?? 0n) !== 0n,
      fundingDone: (w[16] ?? 0n) !== 0n,
      phase: roundPhase({ settled, closesAt }, now),
      clearing: { ...clearing, offeredBelow, wantedAbove },
      rows,
      mine: {
        sell: sellHex ? decodeOrder(sellHex) : null,
        bid: bidHex ? decodeOrder(bidHex) : null,
      },
    },
    nextOpensAt: opensAt + EVERY,
    floorNow,
  };
}

/**
 * What an order gets at the round's price, as far as the page can tell before claiming: every unit past the price, a
 * proportional share at it (the claim works out the exact share), none beyond. For a seller, the money after the cut.
 */
export function orderOutcome(
  round: Pick<RoundView, "floor" | "step" | "clearing" | "rows">,
  side: "sell" | "bid",
  order: RoundOrder,
): { units: bigint; money: bigint } {
  const {
    step: price,
    volume,
    sellersShare,
    offeredBelow,
    wantedAbove,
  } = round.clearing;
  const p = priceOfStep(round, price);
  let filled = 0n;
  const atPrice = round.rows.find((r) => r.step === price);
  if (side === "sell") {
    if (order.step < price) filled = order.amount;
    else if (order.step === price) {
      if (!sellersShare) filled = order.amount;
      else if (atPrice) {
        const offeredHere = atPrice.offered - offeredBelow;
        filled =
          offeredHere === 0n
            ? 0n
            : (order.amount * (volume - offeredBelow)) / offeredHere;
      }
    }
    const value = (filled * p) / UNIT;
    const cut = (filled * (p - round.floor) * CUT_BPS) / (UNIT * 10_000n);
    return { units: filled, money: value - cut };
  }
  if (order.step > price) filled = order.amount;
  else if (order.step === price) {
    if (sellersShare) filled = order.amount;
    else if (atPrice) {
      const wantedHere = atPrice.wanted - wantedAbove;
      filled =
        wantedHere === 0n
          ? 0n
          : (order.amount * (volume - wantedAbove)) / wantedHere;
    }
  }
  return { units: filled, money: escrowFor(filled, p) };
}

/** A round where the connected wallet still has something to collect. */
export interface OpenClaim {
  id: bigint;
  funding: boolean;
  phase: RoundPhase;
  sell: RoundOrder | null;
  bid: RoundOrder | null;
}

/** The most rounds read for what is left to collect, newest first. */
export const MAX_OPEN_CLAIMS = 20;

/**
 * Every round of `dao` where `wallet` placed an order it has not collected and that can be collected now (settled, or
 * void): found from the wallet's own placed orders, so an earlier round never disappears when a new one opens.
 */
export async function readOpenClaims(
  chain: Pick<WorkChain, "call" | "logs">,
  contract: string,
  dao: string,
  wallet: string,
  now: number,
): Promise<OpenClaim[]> {
  const at = assertAddress(contract, "the rounds contract");
  const me = `0x${assertAddress(wallet, "the wallet").slice(2).toLowerCase().padStart(64, "0")}`;
  const [sellLogs, bidLogs] = await Promise.all([
    chain.logs({ address: at, topics: [TOPIC_SELL_PLACED, null, me] }),
    chain.logs({ address: at, topics: [TOPIC_BID_PLACED, null, me] }),
  ]);
  const ids = [
    ...new Set(
      [...sellLogs, ...bidLogs].flatMap((raw) => {
        const t = (raw as LogLike).topics;
        return Array.isArray(t) && typeof t[1] === "string"
          ? [BigInt(t[1] as string)]
          : [];
      }),
    ),
  ]
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, MAX_OPEN_CLAIMS);
  const found = await Promise.all(
    ids.map(async (id): Promise<OpenClaim | null> => {
      const order = (sig: string) =>
        chain.call(
          at,
          encodeFunctionData(sig, ["uint256", "address"], [id, wallet]),
        );
      const [record, sellHex, bidHex] = await Promise.all([
        chain.call(
          at,
          encodeFunctionData(ROUND_SIGNATURES.rounds, ["uint256"], [id]),
        ),
        order(ROUND_SIGNATURES.sells),
        order(ROUND_SIGNATURES.bids),
      ]);
      const w = words(record);
      if (addressOf(w[0]).toLowerCase() !== dao.toLowerCase()) return null;
      const phase = roundPhase(
        { settled: w[8] !== 0n, closesAt: Number(w[3]) },
        now,
      );
      if (phase !== "settled" && phase !== "void") return null;
      const sell = decodeOrder(sellHex);
      const bid = decodeOrder(bidHex);
      const open = (o: RoundOrder | null) => (o && !o.claimed ? o : null);
      if (!open(sell) && !open(bid)) return null;
      return {
        id,
        funding: (w[15] ?? 0n) !== 0n,
        phase,
        sell: open(sell),
        bid: open(bid),
      };
    }),
  );
  return found.flatMap((c) => (c ? [c] : []));
}

// ---- price history ---------------------------------------------------------------------------------

/** How many of the DAO's finished holders' rounds the history lists, newest first. */
export const HISTORY_ROUNDS = 8;
/** The most rounds read while looking for the last trade, past the listed ones. */
export const MAX_HISTORY_READS = 48;

/** A finished holders' round: it traded at a price, traded nothing, or nobody settled it in time. */
export type PastRound =
  | {
      id: bigint;
      closesAt: number;
      outcome: "traded";
      price: bigint;
      volume: bigint;
    }
  | { id: bigint; closesAt: number; outcome: "nothing" | "void" };

export interface RoundHistory {
  /** The DAO's last finished holders' rounds, newest first, at most `HISTORY_ROUNDS`. */
  rounds: PastRound[];
  /** The newest of them that traded, however many rounds back (within `MAX_HISTORY_READS`), or null. */
  lastTrade: Extract<PastRound, { outcome: "traded" }> | null;
  /** Whether every round the DAO opened was read: without it, no last trade means none in the rounds read. */
  complete: boolean;
}

/** One finished holders' round from its `rounds(id)` record, or null for a funding round or one still running. */
export function pastRoundOf(
  id: bigint,
  record: string,
  now: number,
): PastRound | null {
  const w = words(record);
  // Funding rounds sell new units for the project: never a price for holders' Shares.
  if ((w[15] ?? 0n) !== 0n) return null;
  const closesAt = Number(w[3]);
  const phase = roundPhase({ settled: w[8] !== 0n, closesAt }, now);
  if (phase === "void") return { id, closesAt, outcome: "void" };
  if (phase !== "settled") return null;
  const volume = w[11];
  if (volume === 0n) return { id, closesAt, outcome: "nothing" };
  const price = priceOfStep({ floor: w[4], step: w[5] }, Number(w[10]));
  return { id, closesAt, outcome: "traded", price, volume };
}

/**
 * The prices a DAO's holders' rounds traded at (D147): its rounds found from their openings (round ids are shared by
 * every DAO), read newest first. A round that traded nothing never gets a price, and the last trade is looked for past
 * the listed rounds, so a quiet week never hides it.
 */
export async function readRoundHistory(
  chain: Pick<WorkChain, "call" | "logs">,
  contract: string,
  dao: string,
  now: number,
): Promise<RoundHistory> {
  const at = assertAddress(contract, "the rounds contract");
  const opened = await chain.logs({
    address: at,
    topics: [TOPIC_ROUND_OPENED, null, addressTopic(dao)],
  });
  const ids = [
    ...new Set(
      opened.flatMap((raw) => {
        const t = (raw as LogLike).topics;
        return Array.isArray(t) && typeof t[1] === "string"
          ? [BigInt(t[1] as string)]
          : [];
      }),
    ),
  ].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const rounds: PastRound[] = [];
  let lastTrade: RoundHistory["lastTrade"] = null;
  let read = 0;
  // A batch at a time, until the list is full and a trade is found, or every round (or the most allowed) is read.
  while (
    read < ids.length &&
    read < MAX_HISTORY_READS &&
    (rounds.length < HISTORY_ROUNDS || lastTrade === null)
  ) {
    const batch = ids.slice(read, read + HISTORY_ROUNDS);
    read += batch.length;
    const records = await Promise.all(
      batch.map((id) =>
        chain.call(
          at,
          encodeFunctionData(ROUND_SIGNATURES.rounds, ["uint256"], [id]),
        ),
      ),
    );
    for (const [i, id] of batch.entries()) {
      const past = pastRoundOf(id, records[i] as string, now);
      if (!past) continue;
      if (rounds.length < HISTORY_ROUNDS) rounds.push(past);
      if (lastTrade === null && past.outcome === "traded") lastTrade = past;
    }
  }
  return { rounds, lastTrade, complete: read === ids.length };
}
