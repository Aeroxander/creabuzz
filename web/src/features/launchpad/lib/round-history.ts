/**
 * The weekly sale's earlier rounds, read for the price list under the Trading card: which round, when it opened, and
 * either the price and lots it traded or that nothing did. Apart from React so every reader is testable with a fake
 * chain.
 *
 * Round ids run 1 to `roundCount`, and everything the list shows is stored on the round itself (`rounds(id)`, and
 * `clearingOf(id)` for a settled one), so the list is read by id, a fixed block at a time: no event log is scanned and
 * nothing depends on where the chain's history starts. A block is {@link HISTORY_PAGE} rounds, at most two calls each
 * (Review-Proven Rule 4). The ids below a block are counted, never hidden, and read only when asked for.
 *
 * A call that did not complete throws: a block we could not read is never an empty list or a shorter one
 * (Review-Proven Rule 1). The latest round is not here: the card already says where it stands.
 */

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import {
  decodeClearing,
  decodeRound,
  lotPriceAt,
  roundPhase,
  SECONDARY_SIGNATURES,
} from "@creaton/core/launchpad/secondary.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";

/** How many rounds one block lists, so a block is at most twice this many reads. */
export const HISTORY_PAGE = 12;

/** What an earlier round came to. Only a settled round that matched lots has a price. */
type HistoryOutcome =
  | {
      kind: "traded";
      /** Whole lots that changed hands. */
      lots: bigint;
      /** Quote base units for one lot, at the level the round settled at. */
      price: bigint;
    }
  | { kind: "none" };

/** One earlier round. */
export interface HistoryRound {
  id: bigint;
  /** When the round opened (unix seconds), as the market recorded it. */
  opensAt: number;
  outcome: HistoryOutcome;
}

/** One block of earlier rounds, newest first, and how many ids lie below it (always the oldest, 1 up to `older`). */
export interface HistoryBlock {
  rounds: HistoryRound[];
  older: bigint;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Where block `index` starts, as the `before` bound of {@link readHistoryBlock}, or null when no such block is left.
 * Block 0 lists the rounds just below the latest; each next block the {@link HISTORY_PAGE} below that. Round 0 is
 * never read.
 */
export function historyBlockBefore(
  latest: bigint,
  index: number,
): bigint | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const before = latest - BigInt(index) * BigInt(HISTORY_PAGE);
  return before > 1n ? before : null;
}

/**
 * Where one block's read lives in the query cache. It names the market and the block's own bound, so a block read for
 * another market or for an earlier latest round is never taken for this one, and a late answer lands under the key it
 * was asked for (Review-Proven Rule 2). The rounds below the latest are final, so the block never needs re-reading.
 */
export function historyQueryKey(market: string, before: bigint) {
  return [
    "launchpad",
    "secondary-history",
    market.toLowerCase(),
    before.toString(),
  ] as const;
}

/**
 * The rounds below `before`, one block of {@link HISTORY_PAGE}, newest first. A round that cannot be an earlier one
 * (still taking orders at the chain's clock) or a record that is not this market's (never opened) throws, as does any
 * failed call.
 */
export async function readHistoryBlock(
  chain: Pick<WorkChain, "call" | "now">,
  input: { market: string; before: bigint },
): Promise<HistoryBlock> {
  const { market, before } = input;
  if (!ADDRESS_RE.test(market)) throw new Error("The market is not an address");
  if (before < 1n) {
    throw new Error(`the rounds to read start before round ${before}`);
  }
  if (before === 1n) return { rounds: [], older: 0n };
  const lowest =
    before > BigInt(HISTORY_PAGE) ? before - BigInt(HISTORY_PAGE) : 1n;
  const now = await chain.now();
  const ids: bigint[] = [];
  for (let id = before - 1n; id >= lowest; id--) ids.push(id);
  const rounds = await Promise.all(
    ids.map(async (id): Promise<HistoryRound> => {
      const record = decodeRound(
        await chain.call(
          market,
          encodeFunctionData(SECONDARY_SIGNATURES.rounds, ["uint256"], [id]),
        ),
      );
      if (record.opensAt === 0) {
        throw new Error(`the market has no round ${id} below its count`);
      }
      const phase = roundPhase(record, now);
      if (phase === "bidding" || phase === "settling") {
        throw new Error(`round ${id} is not finished yet`);
      }
      // A void round never settled, so nothing traded and a clearing would only be a preview.
      if (phase === "void") {
        return { id, opensAt: record.opensAt, outcome: { kind: "none" } };
      }
      const matched = decodeClearing(
        await chain.call(
          market,
          encodeFunctionData(
            SECONDARY_SIGNATURES.clearingOf,
            ["uint256"],
            [id],
          ),
        ),
      ).matched;
      // A settled round that matched nothing stores the grid's lowest level: a price nobody traded at.
      return {
        id,
        opensAt: record.opensAt,
        outcome:
          matched > 0n
            ? {
                kind: "traded",
                lots: matched,
                price: lotPriceAt(record, record.price),
              }
            : { kind: "none" },
      };
    }),
  );
  return { rounds, older: lowest - 1n };
}

/**
 * The blocks read so far, merged newest first. Only the blocks that arrived in order count: a block that is still
 * reading or failed leaves a gap, and the blocks after it are not shown, so the list never skips rounds. `older` is
 * how many ids lie below the last block shown, or null before any has arrived.
 */
export function mergeHistory(
  blocks: readonly { data?: HistoryBlock | undefined }[],
): { rounds: HistoryRound[]; older: bigint | null; loaded: number } {
  const rounds: HistoryRound[] = [];
  let older: bigint | null = null;
  let loaded = 0;
  for (const block of blocks) {
    if (!block.data) break;
    rounds.push(...block.data.rounds);
    older = block.data.older;
    loaded++;
  }
  return { rounds, older, loaded };
}
