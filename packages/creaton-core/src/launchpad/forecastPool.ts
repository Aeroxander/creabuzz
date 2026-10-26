/**
 * Money forecasts (N8, `contracts/src/ForecastPool.sol`, docs/v3-review/MONEY-FORECASTS.md), an experiment on test
 * networks: two pools of people's own money on "will this bounty on a post be paid?". Whoever was right shares the other
 * pool by what they put in; if nobody was right, everyone takes back their own.
 *
 * Pure apart from the reader, whose chain is injected (`forecastPool.test.mjs` runs it against a fake one). Selectors are
 * pinned to `cast` in the same test.
 */

import { encodeFunctionData } from "./evmAbi.ts";
import type { PostBountyRecord, WalletPosition } from "./openBounty.ts";
import { decodeWord } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The most one wallet puts on one question (6 decimals). */
export const POOL_CAP = 1_000_000_000n;
/** Betting closes this long before the bounty's deadline. */
export const CLOSE_BEFORE = 86_400;

export const FORECAST_POOL_SIGNATURES = {
  bet: "bet(uint256,bool,uint256)",
  settle: "settle(uint256)",
  collect: "collect(uint256,address)",
  pools: "pools(uint256)",
  yesOf: "yesOf(uint256,address)",
  noOf: "noOf(uint256,address)",
  owed: "owed(uint256,address)",
  collected: "collected(uint256,address)",
} as const;

export type PoolOutcome = "open" | "yes" | "no" | "void";
const OUTCOMES: readonly PoolOutcome[] = ["open", "yes", "no", "void"];

export function encodeBet(id: bigint, yes: boolean, amount: bigint): string {
  if (amount <= 0n || amount > POOL_CAP) {
    throw new Error("the amount must be above zero and at most 1,000");
  }
  return encodeFunctionData(
    FORECAST_POOL_SIGNATURES.bet,
    ["uint256", "bool", "uint256"],
    [id, yes, amount],
  );
}

export function encodeSettlePool(id: bigint): string {
  return encodeFunctionData(FORECAST_POOL_SIGNATURES.settle, ["uint256"], [id]);
}

export function encodeCollect(id: bigint, who: string): string {
  if (!ADDRESS_RE.test(who)) throw new Error("not an address");
  return encodeFunctionData(
    FORECAST_POOL_SIGNATURES.collect,
    ["uint256", "address"],
    [id, who],
  );
}

export interface MoneyForecast {
  yes: bigint;
  no: bigint;
  outcome: PoolOutcome;
  /** The connected wallet's part, or null without one. */
  mine: { yes: bigint; no: bigint; owed: bigint; collected: boolean } | null;
}

/** Whether bets are taken now: the pool's own rule (before a day ahead of the deadline, no run, unpaid, unsettled). */
export function poolOpen(
  b: PostBountyRecord,
  outcome: PoolOutcome,
  now: number,
): boolean {
  return (
    outcome === "open" &&
    b.paidClaim === 0 &&
    b.runClaim === 0 &&
    now + CLOSE_BEFORE < b.deadline
  );
}

/** Whether this wallet may bet that the bounty will not be paid: not its creator, and no open claim on it. */
export function mayBetNo(
  b: PostBountyRecord,
  wallet: string,
  me: WalletPosition,
): boolean {
  return wallet.toLowerCase() !== b.creator.toLowerCase() && me.openClaim === 0;
}

/** Whether anyone can settle now: the bounty paid, or its refunds opened. */
export function poolSettleable(
  b: PostBountyRecord,
  outcome: PoolOutcome,
  refundsOpen: boolean,
): boolean {
  return outcome === "open" && (b.paidClaim !== 0 || refundsOpen);
}

/** What `stake` on one side would collect if that side wins, with the pools as they are now. */
export function payoutIfRight(
  stake: bigint,
  side: bigint,
  other: bigint,
): bigint {
  if (stake === 0n || side === 0n) return stake;
  return stake + (other * stake) / side;
}

/** A pool and the connected wallet's part in it. */
export async function readMoneyForecast(
  chain: Pick<WorkChain, "call">,
  pool: string,
  id: bigint,
  wallet: string | null,
): Promise<MoneyForecast> {
  const words = (hex: string) => {
    const body = hex.replace(/^0x/, "");
    const out: bigint[] = [];
    for (let i = 0; i + 64 <= body.length; i += 64) {
      out.push(BigInt(`0x${body.slice(i, i + 64)}`));
    }
    return out;
  };
  const p = words(
    await chain.call(
      pool,
      encodeFunctionData(FORECAST_POOL_SIGNATURES.pools, ["uint256"], [id]),
    ),
  );
  let mine: MoneyForecast["mine"] = null;
  if (wallet) {
    const read = (signature: string) =>
      chain
        .call(
          pool,
          encodeFunctionData(signature, ["uint256", "address"], [id, wallet]),
        )
        .then(decodeWord);
    const [yes, no, owed, collected] = await Promise.all([
      read(FORECAST_POOL_SIGNATURES.yesOf),
      read(FORECAST_POOL_SIGNATURES.noOf),
      read(FORECAST_POOL_SIGNATURES.owed),
      read(FORECAST_POOL_SIGNATURES.collected),
    ]);
    mine = { yes, no, owed, collected: collected !== 0n };
  }
  return {
    yes: p[0] ?? 0n,
    no: p[1] ?? 0n,
    outcome: OUTCOMES[Number(p[2] ?? 0n)] ?? "open",
    mine,
  };
}
