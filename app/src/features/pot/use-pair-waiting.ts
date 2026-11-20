/**
 * The calls waiting in a project's Pair, read from the chain: each `Proposed` log decoded into the exact target, data and
 * number that confirming needs, kept only while it is still waiting (not run, not withdrawn, not out of time). The record
 * does not carry them.
 */
import { decodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  type ChainTaskNow,
  type NoticeFor,
  readBookOf,
  readNoticeFor,
  readTask,
} from "@creaton/core/pot/pot-reads.ts";
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

/** What the network says about the tasks the waiting calls name, read when they are shown (plan section 4.7). */
export interface WaitingTaskFacts {
  /** The task as the chain has it now, by serial; null when it does not exist or could not be read. */
  tasks: Map<string, ChainTaskNow | null>;
  /** What a plan of each share asked for gets; null when it could not be read. */
  notices: Map<number, NoticeFor | null>;
  /** The network's clock. */
  now: number;
}

/** The most task calls whose details are read in one look: a bound on work (a call beyond it is shown as unreadable). */
const MAX_FACTS = 20;

/**
 * What the network says about each task call among `proposals` to `treasury`: the task for a pay, a send back and a
 * withdrawal, and the notice for a plan. One that cannot be read is null (its call is then never offered for confirming),
 * and a read that fails never stops the others.
 */
export async function readTaskFacts(
  ready: Ready,
  treasury: string,
  proposals: readonly Proposal[],
  now: number,
): Promise<WaitingTaskFacts> {
  const facts: WaitingTaskFacts = {
    tasks: new Map(),
    notices: new Map(),
    now,
  };
  let book: string | null | undefined;
  const bookOf = async () => {
    if (book === undefined) {
      try {
        book = await readBookOf(ready.read, treasury);
      } catch {
        book = null;
      }
    }
    return book;
  };
  let read = 0;
  for (const proposal of proposals) {
    if (proposal.target !== treasury.toLowerCase()) continue;
    let call: ReturnType<typeof decodeCall>;
    try {
      call = decodeCall(TREASURY_ABI, proposal.data);
    } catch {
      continue;
    }
    if (!call) continue;
    if (read >= MAX_FACTS) break;
    if (call.name === "announceTask") {
      read += 1;
      const share = Number(call.args[3]);
      if (!facts.notices.has(share)) {
        facts.notices.set(
          share,
          await readNoticeFor(ready.read, treasury, share).catch(() => null),
        );
      }
    } else if (
      call.name === "acceptTask" ||
      call.name === "rejectTask" ||
      call.name === "cancelTask"
    ) {
      read += 1;
      const serial = call.args[0];
      if (typeof serial !== "bigint" || facts.tasks.has(String(serial)))
        continue;
      const where = await bookOf();
      facts.tasks.set(
        String(serial),
        where
          ? await readTask(ready.read, where, serial).catch(() => null)
          : null,
      );
    }
  }
  return facts;
}

/** What is waiting in `pair` right now, read from the chain (see the file's header). Throws when the chain cannot be read. */
export async function readPairWaiting(
  ready: Ready,
  pair: string,
  treasury: string | null = null,
): Promise<{
  waiting: Proposal[];
  complete: boolean;
  facts: WaitingTaskFacts | null;
}> {
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
  const waiting = alive.filter((p): p is Proposal => p !== null);
  return {
    waiting,
    complete: found.complete && (span >= needed || span >= to),
    // What the task calls among them are about, as the chain says now; without a Treasury none is read.
    facts: treasury ? await readTaskFacts(ready, treasury, waiting, now) : null,
  };
}

export function usePairWaiting(
  pair: string | null,
  ready: Ready | null,
  chainId: number,
  treasury: string | null = null,
) {
  return useQuery({
    queryKey: ["pot", "pair-waiting", pair ?? "", chainId, treasury ?? ""],
    enabled: Boolean(pair && ready),
    staleTime: 10_000,
    retry: false,
    queryFn: async () =>
      pair && ready
        ? readPairWaiting(ready, pair, treasury)
        : {
            waiting: [] as Proposal[],
            complete: true,
            facts: null as WaitingTaskFacts | null,
          },
  });
}
