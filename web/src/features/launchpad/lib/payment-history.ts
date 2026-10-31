/**
 * When, and in which transaction, each of a DAO's decisions ran: read from the DAO's own `Executed` events, so a payment
 * a vote made can be checked on the chain, not just counted. A block whose time could not be read leaves the day unknown
 * (`at: null`), never guessed.
 *
 * The chain is injected, so `payment-history.test.mjs` runs the real reader against a fake one. Alias-free for
 * `node --test`.
 */

import { topicOf } from "@creaton/core/launchpad/work.ts";

/** `Executed(uint256 indexed id, address indexed by, uint8 op, address to, uint256 value)` on the DAO. */
export const TOPIC_EXECUTED = topicOf(
  "Executed(uint256,address,uint8,address,uint256)",
);

export interface Execution {
  tx: string;
  block: number;
  /** Unix seconds of its block, or null when the block's time could not be read. */
  at: number | null;
}

export interface ExecutionChain {
  logs(filter: {
    address: string;
    topics: (string | null)[];
  }): Promise<readonly unknown[]>;
  blockTimes(blocks: readonly number[]): Promise<ReadonlyMap<number, number>>;
}

/** The runs of the decisions `ids` (lower-case `0x` + 64 hex), by id; a decision with no `Executed` log has none. */
export async function readExecutions(
  chain: ExecutionChain,
  dao: string,
  ids: readonly string[],
): Promise<Map<string, Execution>> {
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  const found = new Map<string, { tx: string; block: number }>();
  for (const raw of await chain.logs({
    address: dao,
    topics: [TOPIC_EXECUTED],
  })) {
    if (raw === null || typeof raw !== "object") continue;
    const log = raw as {
      topics?: unknown;
      blockNumber?: unknown;
      transactionHash?: unknown;
    };
    const id = Array.isArray(log.topics) ? log.topics[1] : undefined;
    if (
      typeof id !== "string" ||
      !wanted.has(id.toLowerCase()) ||
      typeof log.transactionHash !== "string" ||
      typeof log.blockNumber !== "string"
    ) {
      continue;
    }
    try {
      found.set(id.toLowerCase(), {
        tx: log.transactionHash,
        block: Number(BigInt(log.blockNumber)),
      });
    } catch {
      // A malformed block number: leave the run out rather than show a wrong one.
    }
  }
  const blocks = [...new Set([...found.values()].map((r) => r.block))];
  const times = blocks.length > 0 ? await chain.blockTimes(blocks) : new Map();
  return new Map(
    [...found].map(([id, run]) => [
      id,
      { ...run, at: times.get(run.block) ?? null },
    ]),
  );
}
