/**
 * The two launch filters the plan asks for — "Closing soon" and "Graduated" —
 * shared by Home's launch tabs and the launches list, so the two surfaces
 * cannot disagree about what either word means.
 *
 * - "Closing soon" is chain-truth: an auction's end is a block number, so the
 *   filter needs the chain head. When the head cannot be read the list is
 *   honestly empty — an auction is never guessed to be closing.
 * - "Graduated" defaults to the receipt-proven stage (the same rule
 *   `models.ts effectiveStage` uses) and takes an optional chain read (the
 *   auction's `isGraduated`), so a caller with live chain data passes it in
 *   instead of trusting relay records alone.
 *
 * Pure and alias-free: `launch-filters.test.mjs` drives it under `node --test`.
 */

/** The structural slice of a launch these filters need. */
export interface FilterableLaunch {
  record: {
    author: string;
    createdAt: number;
    endBlock: number | null;
    stage: string;
  };
  receipts: readonly { table: string }[];
}

/**
 * Blocks left that count as "closing soon": ~12 hours at 12-second blocks.
 * The auctions run on EVM chains with second-scale block times, so the error
 * from a different block time is hours, not days.
 */
export const CLOSING_SOON_BLOCKS = 3_600;

/** Receipts that mean the auction's outcome is already recorded. */
const SETTLED_TABLES = new Set(["summon", "graduate", "failed", "refund-open"]);

function isSettled(launch: FilterableLaunch): boolean {
  return launch.receipts.some((r) => SETTLED_TABLES.has(r.table));
}

/**
 * Live auctions whose end block is within `thresholdBlocks` of the chain head,
 * soonest-ending first. A null head (the chain could not be read) yields
 * nothing: no guess, no false "closing" badge.
 */
export function closingSoonLaunches<T extends FilterableLaunch>(
  launches: readonly T[],
  currentBlock: number | bigint | null,
  thresholdBlocks: number = CLOSING_SOON_BLOCKS,
): T[] {
  if (currentBlock === null) return [];
  const head =
    typeof currentBlock === "bigint" ? currentBlock : BigInt(currentBlock);
  const soon = launches.filter((launch) => {
    const stage = launch.record.stage;
    if (stage !== "live" && stage !== "funding") return false;
    if (isSettled(launch)) return false;
    if (launch.record.endBlock === null) return false;
    const left = BigInt(launch.record.endBlock) - head;
    return left > 0n && left <= BigInt(thresholdBlocks);
  });
  return soon.sort(
    (a, b) => (a.record.endBlock ?? 0) - (b.record.endBlock ?? 0),
  );
}

/**
 * The receipt-proven graduation rule (mirrors `models.ts effectiveStage`):
 * a summon or graduate receipt, or a record that already says "graduated".
 */
export function receiptProvenGraduated(launch: FilterableLaunch): boolean {
  return (
    launch.record.stage === "graduated" ||
    launch.receipts.some((r) => r.table === "summon" || r.table === "graduate")
  );
}

/**
 * Launches whose auction graduated — newest graduation first. Pass the chain's
 * `isGraduated` read as `isGraduated` when one is available; the default is
 * the relay's receipt-proven rule above.
 */
export function graduatedLaunches<T extends FilterableLaunch>(
  launches: readonly T[],
  isGraduated: (launch: T) => boolean = (launch) =>
    receiptProvenGraduated(launch),
): T[] {
  return launches
    .filter((launch) => isGraduated(launch))
    .sort((a, b) => b.record.createdAt - a.record.createdAt);
}
