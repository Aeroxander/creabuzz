/**
 * Post-sale fund-flow model — "where did the money go?" in one screen.
 *
 * Every number the panel shows is derived here (pure) from one of three
 * sources, and each row keeps its source so the UI can link it:
 *
 * 1. **The GraduationExecutor split** (`contracts/src/GraduationExecutor.sol`,
 *    READ-ONLY): `graduations(auction)` returns the immutable record
 *    (initialPriceX96, tokensSold, currencyRaised, reserveEscrow,
 *    treasuryShare, unsoldTokens, tokenMasterPool, executed — :34-45). The
 *    split math is `reserveShare = currencyRaised * reserveBps / 10_000`,
 *    `treasuryShare = currencyRaised - reserveShare` (:253-255) — the reserve
 *    stays escrowed until `releaseReserve` (:79-117) and the treasury share
 *    was swept at execution (:77-129).
 * 2. **The 47005 `sweep`/`lock` receipts** the deploy publishes
 *    (`desktop/src/features/launchpad/lib/graduationFlow.ts:296-341` payload
 *    shapes, READ-ONLY reference) — the recorded history of the same money.
 * 3. **Contract position reads** — the treasury's and pool's current token
 *   balances and the executor's unreleased escrow (`../chain.ts` seam).
 *
 * Plus the org spend plane (kind:37012 budgets + kind:37014 spend receipts +
 * `contracts/src/OrgAllowance.sol` reads) in `org-money.ts`.
 *
 * Explorer links: `explorerTxUrl`/`explorerAddressUrl` return null for
 * chains without a known explorer (dev anvil included) — the UI then shows
 * the raw hash and says there is no explorer, instead of fabricating a URL.
 */
import {
  decodeU256,
  erc20BalanceOf,
  ethCall,
  ethGetBalance,
} from "../chain.ts";
import {
  buildGraduationsView,
  decodeGraduationRecord,
  type GraduationRecord,
} from "@creaton/core/launchpad/graduationFlow.ts";
import { addressWordValue } from "@creaton/core/launchpad/auctionPlan.ts";
import type { LaunchReceipt } from "../models.ts";
import { ETH_TOKEN } from "./ragequit-tx.ts";

// ------------------------------------------------------------- selectors ----
// `cast sig` goldens (recorded in `fund-flow.test.mjs`):
export const SELECTOR_FUNDS_RECIPIENT = "0x3b6fd2cf"; // fundsRecipient()
export const SELECTOR_CURRENCY = "0xe5a6b10f"; // currency()
export const SELECTOR_GRADUATIONS = "0x62e3857f"; // graduations(address)
export const SELECTOR_RESERVE_BPS = "0x38925449"; // reserveBps()
export const SELECTOR_TREASURY = "0x61d027b3"; // treasury()

// ----------------------------------------------------- graduation record ----
// The record, its decoder and the `graduations(auction)` view call live once in
// `@creaton/core`; they are re-exported here so this module's callers keep one
// import site.
export { buildGraduationsView, decodeGraduationRecord };

/** The onchain side of the split, as the panel reads it. */
export interface GraduationState {
  /** `fundsRecipient()` on the auction — the GraduationExecutor. */
  executor: string;
  /** `currency()` on the auction — what the raise was denominated in. */
  currency: string;
  /** `treasury()` on the executor — where the treasury share went. */
  treasury: string;
  /** `reserveBps()` on the executor — the reserve half of the split. */
  reserveBps: bigint;
  /** `graduations(auction)` — the immutable record; zeroed before execution. */
  record: GraduationRecord;
}

/** Thin fetcher over the `../chain.ts` seam; decode/math stay pure. */
export async function fetchGraduationState(
  endpoint: string,
  auction: string,
): Promise<GraduationState> {
  const [executorRaw, currencyRaw] = await Promise.all([
    ethCall(endpoint, auction, SELECTOR_FUNDS_RECIPIENT),
    ethCall(endpoint, auction, SELECTOR_CURRENCY),
  ]);
  const executor = decodeAddressWord(
    executorRaw,
    "the sale did not say where its money goes, so it does not use the standard payout step",
  );
  const currency = decodeAddressWord(
    currencyRaw,
    "the sale did not say which currency it raised in",
  );
  const [treasuryRaw, bpsRaw, recordRaw] = await Promise.all([
    ethCall(endpoint, executor, SELECTOR_TREASURY),
    ethCall(endpoint, executor, SELECTOR_RESERVE_BPS),
    ethCall(endpoint, executor, buildGraduationsView(executor, auction).data),
  ]);
  return {
    executor,
    currency,
    treasury: decodeAddressWord(
      treasuryRaw,
      "the payout step did not say where the project's money goes. Check that the sale uses the standard payout step",
    ),
    reserveBps: decodeU256(bpsRaw),
    record: decodeGraduationRecord(recordRaw),
  };
}

function decodeAddressWord(returnData: string, message: string): string {
  try {
    return addressWordValue(returnData);
  } catch {
    throw new Error(message);
  }
}

/**
 * The split math of `executeGraduation` (GraduationExecutor.sol:253-255):
 * `reserveShare = currencyRaised * reserveBps / 10_000` (floor) and
 * `treasuryShare = currencyRaised - reserveShare` — the treasury takes the
 * remainder so the two shares always sum to the raise.
 */
export function graduationSplit(input: {
  currencyRaised: bigint;
  reserveBps: bigint;
}): { reserveShare: bigint; treasuryShare: bigint } {
  const { currencyRaised, reserveBps } = input;
  if (reserveBps < 0n || reserveBps > 10_000n) {
    throw new Error(`fund-flow: reserveBps out of range: ${reserveBps}`);
  }
  const reserveShare = (currencyRaised * reserveBps) / 10_000n;
  return { reserveShare, treasuryShare: currencyRaised - reserveShare };
}

// ------------------------------------------------------------ receipts ----

/** Every receipt word this panel renders as money movement. */
type FundFlowTable = "sweep" | "lock" | "summon" | "ragequit";

/** One money-movement row backed by a 47005 receipt. */
export interface ReceiptRow {
  table: FundFlowTable;
  tx: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

/**
 * Pull the money-movement receipts out of a launch's receipt list. Unknown
 * tables (`claim`, `verdict`, `stream`, `cancel`, `auction-created`, `bid`)
 * are history of other surfaces and stay out of this panel.
 */
export function fundFlowReceiptRows(
  receipts: readonly LaunchReceipt[],
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  for (const receipt of receipts) {
    if (
      receipt.table === "sweep" ||
      receipt.table === "lock" ||
      receipt.table === "summon" ||
      receipt.table === "ragequit"
    ) {
      rows.push({
        table: receipt.table,
        tx: receipt.tx,
        createdAt: receipt.createdAt,
        payload: receipt.payload,
      });
    }
  }
  rows.sort((a, b) => a.createdAt - b.createdAt);
  return rows;
}

// ----------------------------------------------------------- positions ----

/** One treasury/pool/escrow position row. */
export interface PositionRow {
  label: "treasury" | "pool" | "escrow";
  token: string;
  balance: bigint;
  /** Where the balance lives (the holder address). */
  holder: string;
  source: "chain";
}

/**
 * The three money positions post-sale: what the treasury holds, what sits in
 * the launch token's master pool (the TM floor), and what is still escrowed
 * at the executor awaiting `releaseReserve`.
 */
export async function fetchFundFlowPositions(
  endpoint: string,
  input: {
    currency: string;
    treasury: string;
    tokenMasterPool: string;
    executor: string;
  },
): Promise<PositionRow[]> {
  const currency = input.currency.toLowerCase();
  const readBalance = async (holder: string): Promise<bigint> => {
    const balance =
      currency === ETH_TOKEN
        ? await ethGetBalance(endpoint, holder)
        : await erc20BalanceOf(endpoint, input.currency, holder);
    if (balance === null) {
      // A failed read is an error, never a zero position (Review-Proven
      // Rule 1 — no terminal failure rendered as an authoritative empty).
      throw new Error(`could not read the balance held by ${holder}`);
    }
    return balance;
  };
  const holders: Array<[PositionRow["label"], string]> = [
    ["treasury", input.treasury],
    ["escrow", input.executor],
  ];
  if (input.tokenMasterPool) {
    holders.push(["pool", input.tokenMasterPool]);
  }
  return Promise.all(
    holders.map(async ([label, holder]) => ({
      label,
      token: currency,
      balance: await readBalance(holder),
      holder,
      source: "chain" as const,
    })),
  );
}

// ----------------------------------------------------------- explorer ----

/** Explorer link builders — null when no explorer is known for the chain. */
const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
  42161: "https://arbiscan.io",
  10: "https://optimistic.etherscan.io",
};

export function explorerTxUrl(chainId: number, tx: string): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${tx}` : null;
}

export function explorerAddressUrl(
  chainId: number,
  address: string,
): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/address/${address}` : null;
}
