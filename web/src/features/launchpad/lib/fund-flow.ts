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
import type { LaunchReceipt } from "../models.ts";
import { ETH_TOKEN } from "./ragequit-tx.ts";

// ------------------------------------------------------------- selectors ----
// `cast sig` goldens (recorded in `fund-flow.test.mjs`):
export const SELECTOR_FUNDS_RECIPIENT = "0x3b6fd2cf"; // fundsRecipient()
export const SELECTOR_CURRENCY = "0xe5a6b10f"; // currency()
export const SELECTOR_GRADUATIONS = "0x62e3857f"; // graduations(address)
export const SELECTOR_RESERVE_BPS = "0x38925449"; // reserveBps()
export const SELECTOR_TREASURY = "0x61d027b3"; // treasury()

function addressWord(address: string): string {
  return address.toLowerCase().slice(2).padStart(64, "0");
}

function wordList(hex: string): string[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 64 !== 0) {
    throw new Error(`fund-flow: expected whole ABI words, got ${hex}`);
  }
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

function wordValue(w: string): bigint {
  return BigInt(`0x${w}`);
}

function addressWordValue(w: string): string {
  return `0x${w.slice(24).toLowerCase()}`;
}

// ----------------------------------------------------- graduation record ----

/** The `graduations(address)` record (GraduationExecutor.sol:34-45). */
export interface GraduationRecord {
  initialPriceX96: bigint;
  tokensSold: bigint;
  currencyRaised: bigint;
  reserveEscrow: bigint;
  treasuryShare: bigint;
  unsoldTokens: bigint;
  tokenMasterPool: string;
  executed: boolean;
}

/** Decode the 8-word `graduations(address)` getter return (struct-as-words). */
export function decodeGraduationRecord(returnData: string): GraduationRecord {
  const w = wordList(returnData);
  if (w.length !== 8) {
    throw new Error(
      `expected 8 words from graduations(address), got ${w.length}`,
    );
  }
  return {
    initialPriceX96: wordValue(w[0]),
    tokensSold: wordValue(w[1]),
    currencyRaised: wordValue(w[2]),
    reserveEscrow: wordValue(w[3]),
    treasuryShare: wordValue(w[4]),
    unsoldTokens: wordValue(w[5]),
    tokenMasterPool: addressWordValue(w[6]),
    executed: wordValue(w[7]) !== 0n,
  };
}

/** The executor's `graduations(auction)` view call. */
export function buildGraduationsView(
  executor: string,
  auction: string,
): { to: string; data: string } {
  return {
    to: executor.toLowerCase(),
    data: `${SELECTOR_GRADUATIONS}${addressWord(auction)}`,
  };
}

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
    "the auction did not answer fundsRecipient() — it is not on the GraduationExecutor rails",
  );
  const currency = decodeAddressWord(
    currencyRaw,
    "the auction did not answer currency()",
  );
  const [treasuryRaw, bpsRaw, recordRaw] = await Promise.all([
    ethCall(endpoint, executor, SELECTOR_TREASURY),
    ethCall(endpoint, executor, SELECTOR_RESERVE_BPS),
    ethCall(
      endpoint,
      executor,
      `${SELECTOR_GRADUATIONS}${addressWord(auction)}`,
    ),
  ]);
  return {
    executor,
    currency,
    treasury: decodeAddressWord(
      treasuryRaw,
      "the executor did not answer treasury() — is fundsRecipient really a GraduationExecutor?",
    ),
    reserveBps: decodeU256(bpsRaw),
    record: decodeGraduationRecord(recordRaw),
  };
}

function decodeAddressWord(returnData: string, message: string): string {
  const w = wordList(returnData);
  if (w.length < 1) throw new Error(`fund-flow: ${message}`);
  return addressWordValue(w[0]);
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

/** Decoded 47005 `sweep` receipt payload (graduationFlow.ts:296-319 shape). */
export interface SweepReceipt {
  table: "sweep";
  auction: string;
  currencyRaised: bigint;
  treasuryShare: bigint;
  unsoldTokens: bigint;
  tx: string;
  createdAt: number;
}

/** Decoded 47005 `lock` receipt payload (graduationFlow.ts:322-341 shape). */
export interface LockReceipt {
  table: "lock";
  auction: string;
  reserveEscrow: bigint;
  tx: string;
  createdAt: number;
}

function bigintField(payload: Record<string, unknown>, field: string): bigint {
  const raw = payload[field];
  if (typeof raw === "number") return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "bigint") return raw;
  throw new Error(
    `fund-flow: receipt payload.${field} must be a decimal string`,
  );
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const raw = payload[field];
  if (typeof raw !== "string" || !raw) {
    throw new Error(`fund-flow: receipt payload.${field} must be a string`);
  }
  return raw;
}

/** Decode one `sweep` receipt (thrown on a malformed payload). */
export function decodeSweepReceipt(receipt: LaunchReceipt): SweepReceipt {
  return {
    table: "sweep",
    auction: stringField(receipt.payload, "auction"),
    currencyRaised: bigintField(receipt.payload, "currencyRaised"),
    treasuryShare: bigintField(receipt.payload, "treasuryShare"),
    unsoldTokens: bigintField(receipt.payload, "unsoldTokens"),
    tx: receipt.tx,
    createdAt: receipt.createdAt,
  };
}

/** Decode one `lock` receipt (thrown on a malformed payload). */
export function decodeLockReceipt(receipt: LaunchReceipt): LockReceipt {
  return {
    table: "lock",
    auction: stringField(receipt.payload, "auction"),
    reserveEscrow: bigintField(receipt.payload, "reserveEscrow"),
    tx: receipt.tx,
    createdAt: receipt.createdAt,
  };
}

/**
 * What one `sweep` receipt says about the split — the recorded side of the
 * onchain math: the treasury share is explicit and the reserve is the
 * remainder (`raised - treasuryShare`), matching GraduationExecutor.sol:254.
 */
export function splitFromSweepReceipt(sweep: SweepReceipt): {
  reserveShare: bigint;
  treasuryShare: bigint;
} {
  return {
    reserveShare: sweep.currencyRaised - sweep.treasuryShare,
    treasuryShare: sweep.treasuryShare,
  };
}

/** Every receipt word this panel renders as money movement. */
export type FundFlowTable = "sweep" | "lock" | "summon" | "ragequit";

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
      throw new Error(`could not read ${currency} balance of ${holder}`);
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
