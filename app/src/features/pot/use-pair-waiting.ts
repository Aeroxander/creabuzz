/**
 * The calls waiting in a project's Pair, read from the chain: each `Proposed` log decoded into the exact target, data and
 * number that confirming needs, kept only while it is still waiting (not run, not withdrawn, not out of time). The record
 * does not carry them.
 */
import { decodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { proposalTtl, readProposal } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import type { ChainLog } from "../money/wallet";
import { readLogsBack } from "../money/wallet";
import type { Ready } from "./use-pot";

const PROPOSED_TOPIC = topicOf(
  "Proposed(bytes32,address,address,bytes,uint256)",
);
const HEX32 = /^0x[0-9a-f]{64}$/;
/** How far back to look when the network cannot say how fast it makes blocks, in blocks. */
const WINDOW_BLOCKS = 50_000;
/** The most blocks ever looked back over, in pieces of `CHUNK` (a window wider than this is said to be incomplete). */
const MAX_WINDOW = 600_000;
const CHUNK = 10_000;
/** Blocks sampled to learn how fast the network makes them. */
const SAMPLE_BLOCKS = 5_000;

/**
 * How many blocks back a waiting call can still be in time: the Pair's own limit (read from it) over the network's own pace
 * of blocks (the last `SAMPLE_BLOCKS` of them), with a margin. `needed` is what covering it takes, `span` what is looked at.
 */
export function windowOf(
  ttlSecs: number,
  head: number,
  headTime: number,
  sampleTime: number | null,
  sampleBlocks: number,
): { span: number; needed: number } {
  let needed = WINDOW_BLOCKS;
  if (sampleTime !== null && sampleBlocks > 0) {
    const secsPerBlock = (headTime - sampleTime) / sampleBlocks;
    // Blocks that share a second (a test chain) say nothing about pace: look as far as is allowed.
    needed =
      secsPerBlock > 0
        ? Math.ceil((ttlSecs / secsPerBlock) * 1.25) + 1_000
        : MAX_WINDOW;
  }
  return { span: Math.min(needed, MAX_WINDOW, head), needed };
}

export interface Proposal {
  id: string;
  by: string;
  target: string;
  data: string;
  nonce: bigint;
}

/** A `Proposed` log of this Pair as a proposal, or null when it is not one. */
export function proposalOf(log: ChainLog, pair: string): Proposal | null {
  if (log.address.toLowerCase() !== pair.toLowerCase()) return null;
  const [topic, id, by] = log.topics.map((t) => t.toLowerCase());
  if (topic !== PROPOSED_TOPIC || !id || !by) return null;
  if (!HEX32.test(id) || !HEX32.test(by)) return null;
  try {
    const [target, data, nonce] = decodeParameters(
      ["address", "bytes", "uint256"],
      log.data,
    );
    if (typeof target !== "string" || typeof data !== "string") return null;
    if (typeof nonce !== "bigint") return null;
    return {
      id,
      by: `0x${by.slice(26)}`,
      target: target.toLowerCase(),
      data: data.toLowerCase(),
      nonce,
    };
  } catch {
    return null;
  }
}

/** What is waiting in `pair` right now, read from the chain (see the file's header). Throws when the chain cannot be read. */
export async function readPairWaiting(
  ready: Ready,
  pair: string,
): Promise<{ waiting: Proposal[]; complete: boolean }> {
  const wallet = ready.wallet;
  const ttl = await proposalTtl(ready.read, pair);
  const to = await wallet.blockNumber();
  // The chain's own clock and pace (a browser clock can differ from a test chain's), where the sender can say them.
  let now = Math.floor(Date.now() / 1000);
  let sampleTime: number | null = null;
  const sample = Math.min(to, SAMPLE_BLOCKS);
  if (wallet.blockTime) {
    try {
      now = await wallet.blockTime("latest");
      sampleTime = sample > 0 ? await wallet.blockTime(to - sample) : null;
    } catch {
      sampleTime = null;
    }
  }
  const { span, needed } = windowOf(ttl, to, now, sampleTime, sample);
  const found = await readLogsBack(
    wallet,
    { address: pair, topics: [PROPOSED_TOPIC] },
    {
      from: Math.max(0, to - span),
      to,
      chunk: CHUNK,
      pieces: Math.ceil(MAX_WINDOW / CHUNK),
    },
  );
  const proposals = found.logs
    .map((log) => proposalOf(log, pair))
    .filter((p): p is Proposal => p !== null);
  const alive = await Promise.all(
    proposals.map(async (p) => {
      const state = await readProposal(ready.read, pair, p.id);
      return state && state.proposedAt + ttl >= now ? p : null;
    }),
  );
  return {
    waiting: alive.filter((p): p is Proposal => p !== null),
    complete: found.complete && (span >= needed || span >= to),
  };
}

export function usePairWaiting(
  pair: string | null,
  ready: Ready | null,
  chainId: number,
) {
  return useQuery({
    queryKey: ["pot", "pair-waiting", pair ?? "", chainId],
    enabled: Boolean(pair && ready),
    staleTime: 10_000,
    retry: false,
    queryFn: async () =>
      pair && ready
        ? readPairWaiting(ready, pair)
        : { waiting: [] as Proposal[], complete: true },
  });
}
