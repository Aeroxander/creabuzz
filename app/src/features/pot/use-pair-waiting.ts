/**
 * The calls waiting in a project's Pair, read from the chain: each `Proposed` log decoded into the exact target, data and
 * number that confirming needs, kept only while it is still waiting (not run, not withdrawn, not out of time). The record
 * does not carry them.
 */
import { decodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { readProposal } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import type { ChainLog } from "../money/wallet";
import { readLogsBack } from "../money/wallet";
import type { Ready } from "./use-pot";

const PROPOSED_TOPIC = topicOf(
  "Proposed(bytes32,address,address,bytes,uint256)",
);
const HEX32 = /^0x[0-9a-f]{64}$/;
/** A waiting call's life: the Pair's own limit (14 days). */
const TTL_SECS = 14 * 24 * 3600;
/** How far back to look for them, in blocks. */
const WINDOW_BLOCKS = 50_000;

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
    queryFn: async (): Promise<{ waiting: Proposal[]; complete: boolean }> => {
      if (!pair || !ready) return { waiting: [], complete: true };
      const to = await ready.wallet.blockNumber();
      const found = await readLogsBack(
        ready.wallet,
        { address: pair, topics: [PROPOSED_TOPIC] },
        { from: Math.max(0, to - WINDOW_BLOCKS), to },
      );
      const proposals = found.logs
        .map((log) => proposalOf(log, pair))
        .filter((p): p is Proposal => p !== null);
      const now = Math.floor(Date.now() / 1000);
      const alive = await Promise.all(
        proposals.map(async (p) => {
          const state = await readProposal(ready.read, pair, p.id);
          return state && state.proposedAt + TTL_SECS >= now ? p : null;
        }),
      );
      return {
        waiting: alive.filter((p): p is Proposal => p !== null),
        complete: found.complete,
      };
    },
  });
}
