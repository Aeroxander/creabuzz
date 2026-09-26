/**
 * Calendar time → chain blocks, with the measurement shown honestly.
 *
 * The auction contract speaks blocks (`startBlock`, `endBlock`, `claimBlock`);
 * a founder speaks days. Somebody has to convert, and every honest way of
 * converting needs three things this module keeps in one place:
 *
 * 1. **A measured block time.** `secondsPerBlockFrom` takes recent block
 *    timestamps and returns the median gap — median, not mean, so one empty
 *    slot or one timestamp jitter does not move the window. Fewer than two
 *    usable gaps means no answer, never a guess (the caller falls back).
 * 2. **A documented per-chain default.** Base produces a block every 2s
 *    (`launch-params.ts`'s `BLOCKS_PER_DAY = 43200`), Ethereum every 12s.
 *    When the RPC cannot be read we use the chain picker's own
 *    `CHAIN_PRESETS.blockTimeSeconds` (resolved by `documentedBlockTimeSeconds`
 *    in `../chain.ts`, so the two cannot drift) and say so.
 * 3. **A safety margin that only ever rounds one way.** A sale that ends
 *    *earlier* than the founder chose is a broken promise, so the window is
 *    rounded up (start buffer + `END_SAFETY_MARGIN_BPS`), never down. The
 *    conversion line in the dialog states this instead of hiding it.
 *
 * Pure and alias-free on purpose: `time-blocks.test.mjs` drives it under
 * `node --test`. The RPC sampling that feeds it lives in `../chain.ts`.
 */

/** Recent blocks sampled for a block-time measurement (bounded: rule 4). */
export const SAMPLE_BLOCKS = 8;

/** Blocks between "publish" and "auction starts": sign + relay round-trips. */
export const START_BUFFER_SECONDS = 300;

/** Half a day between the auction closing and claims opening. */
export const CLAIM_DELAY_SECONDS = 12 * 60 * 60;

/** Extra window, in basis points, so a slower-than-measured chain still ends on time. */
export const END_SAFETY_MARGIN_BPS = 200;

/** Base produces a block every 2 seconds (`launch-params.ts`). */
export const DEFAULT_SECONDS_PER_BLOCK = 2;

/** One block as the node reported it. */
export interface BlockSample {
  block: number;
  /** Unix seconds. */
  timestampSeconds: number;
}

/**
 * Median seconds-per-block across consecutive sampled blocks.
 *
 * Only gaps between *consecutive* blocks count (a reorg or a skipped fetch
 * would otherwise read as a multi-block jump), and only positive gaps. Null
 * means the sample could not answer — the caller falls back to the table.
 */
export function secondsPerBlockFrom(
  samples: readonly BlockSample[],
): number | null {
  const ordered = [...samples].sort((a, b) => a.block - b.block);
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (current.block !== previous.block + 1) continue;
    const gap = current.timestampSeconds - previous.timestampSeconds;
    if (gap > 0 && Number.isFinite(gap)) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 1
      ? gaps[middle]
      : (gaps[middle - 1] + gaps[middle]) / 2;
  return median > 0 ? median : null;
}

/** `2026-10-03` → that day's last second (UTC), or null when unusable. */
export function endSecondsFromDateInput(
  value: string,
  nowSeconds: number,
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const parsed = Date.parse(`${match[0]}T23:59:59Z`);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.floor(parsed / 1000);
  // An end in the past is a typo, not a zero-length sale.
  return seconds > nowSeconds ? seconds : null;
}

/** Whole seconds → whole blocks, never rounding a window down to nothing. */
export function blocksForSeconds(
  seconds: number,
  secondsPerBlock: number,
): number {
  if (!(seconds > 0) || !(secondsPerBlock > 0)) return 0;
  return Math.max(1, Math.ceil(seconds / secondsPerBlock));
}

export interface SaleBlockPlan {
  startBlock: number;
  endBlock: number;
  claimBlock: number;
  /** The seconds-per-block the conversion used. */
  secondsPerBlock: number;
  /** `measured` = sampled from this chain; `default` = documented table. */
  source: "measured" | "default";
  /** The duration the founder asked for, before the safety margin. */
  requestedSeconds: number;
  /** Blocks from start to end, including the margin. */
  windowBlocks: number;
  /** Blocks added beyond the request so a slow chain cannot end it early. */
  marginBlocks: number;
}

export interface SaleBlockPlanInput {
  /** Chain head when the measurement was taken. */
  head: number;
  /** Unix seconds of the measurement. */
  nowSeconds: number;
  secondsPerBlock: number;
  source?: "measured" | "default";
  /** Either a duration… */
  durationSeconds?: number;
  /** …or an absolute end instant (UTC). Exactly one must be usable. */
  endAtSeconds?: number;
}

/**
 * The block window for a sale, rounded in the safe direction.
 *
 * `startBlock` sits `START_BUFFER_SECONDS` past the head so publishing and
 * deploying cannot land on an already-passed start; `endBlock` is the request
 * plus the safety margin; `claimBlock` is a half day later, matching
 * `standardLaunchPreset`. Null when the request is empty or already past —
 * a window that ends in the past is not a window.
 */
export function planSaleBlocks(
  input: SaleBlockPlanInput,
): SaleBlockPlan | null {
  const { head, nowSeconds } = input;
  const secondsPerBlock = input.secondsPerBlock;
  if (!(secondsPerBlock > 0) || !Number.isFinite(head) || head < 0) return null;
  if (!Number.isFinite(nowSeconds) || nowSeconds <= 0) return null;

  const endAtSeconds =
    input.durationSeconds !== undefined
      ? nowSeconds + input.durationSeconds
      : input.endAtSeconds;
  if (endAtSeconds === undefined || !Number.isFinite(endAtSeconds)) return null;
  const requestedSeconds = endAtSeconds - nowSeconds;
  // Zero or negative: the founder picked an instant that has already passed.
  if (requestedSeconds <= 0) return null;

  const startOffset = blocksForSeconds(START_BUFFER_SECONDS, secondsPerBlock);
  const requestedBlocks = blocksForSeconds(requestedSeconds, secondsPerBlock);
  const marginBlocks = Math.max(
    1,
    Math.ceil((requestedBlocks * END_SAFETY_MARGIN_BPS) / 10_000),
  );
  const startBlock = head + startOffset;
  const windowBlocks = requestedBlocks + marginBlocks;
  const endBlock = startBlock + windowBlocks;
  const claimBlock =
    endBlock + blocksForSeconds(CLAIM_DELAY_SECONDS, secondsPerBlock);

  return {
    startBlock,
    endBlock,
    claimBlock,
    secondsPerBlock,
    source: input.source ?? "default",
    requestedSeconds,
    windowBlocks,
    marginBlocks,
  };
}

/**
 * The conversion the dialog shows: plain about time, honest about blocks.
 *
 * The happy path never asks anyone to think in blocks; this line exists so the
 * number written to the record is not a number the founder never saw.
 */
export function describeSaleBlocks(plan: SaleBlockPlan): string {
  const seconds = plan.requestedSeconds;
  const days = seconds / 86_400;
  const duration =
    days >= 1
      ? `${roundReadable(days)} day${roundReadable(days) === 1 ? "" : "s"}`
      : `${roundReadable(seconds / 3_600)} hour${roundReadable(seconds / 3_600) === 1 ? "" : "s"}`;
  const source =
    plan.source === "measured"
      ? `a block every ${roundReadable(plan.secondsPerBlock)}s on this chain`
      : `this chain's default of a block every ${roundReadable(plan.secondsPerBlock)}s (the chain could not be read)`;
  return `That's ≈ ${plan.windowBlocks.toLocaleString("en-US")} blocks for ${duration} at ${source} — the app rounds ${plan.marginBlocks.toLocaleString("en-US")} blocks longer than asked so a slow chain can't close the sale early.`;
}

function roundReadable(value: number): number {
  if (value >= 10) return Math.round(value);
  return Math.round(value * 10) / 10;
}
