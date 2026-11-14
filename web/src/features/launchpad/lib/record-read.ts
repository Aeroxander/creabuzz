/**
 * What a DAO's public record needs beyond what the Work and Decisions tabs already read: when each claim was filed and
 * paid, which reviewer said what, and which team Shares are still held back and which milestone freed the rest.
 *
 * All of it comes from the chain's own logs and calls, never from a record somebody wrote about it. Every read is
 * bounded (Review-Proven Rule 4); anything cut off is reported through `truncated` so the page can say so instead of
 * quietly showing a shorter history.
 *
 * The chain is injected, so `record-read.test.mjs` runs the real reader against a fake one. Alias-free for
 * `node --test`.
 */

import {
  decodeAddress,
  encodeCall0,
  TOPIC_CLAIM_SUBMITTED,
  topicOf,
} from "@creaton/core/launchpad/work.ts";
import type {
  WorkChain,
  WorkSnapshot,
} from "@creaton/core/launchpad/workRead.ts";
import {
  LOCK_SIGNATURES,
  readMilestoneLock,
  type MilestoneTranche,
} from "@creaton/core/launchpad/milestoneLock.ts";

/** The newest log entries read for one event on one contract. */
export const MAX_RECORD_LOGS = 400;
/** The most distinct wallets looked at as possible team members (the kit names at most 16). */
const MAX_HOLDERS = 64;
/** The most distinct blocks whose time is looked up. */
const MAX_BLOCKS = 200;

const TOPIC_CLAIM_PAID = topicOf("ClaimPaid(bytes32)");
const TOPIC_ATTESTED = topicOf("Attested(bytes32,address,bool)");
const TOPIC_TRANSFER = topicOf("Transfer(address,address,uint256)");
const TOPIC_UNLOCKED = topicOf(
  "Unlocked(address,uint256,uint96,bytes32,uint256)",
);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

export interface RecordChain extends WorkChain {
  /** The time, in seconds, of each block that could be fetched. A block that could not be is left out, never guessed. */
  blockTimes(blocks: readonly number[]): Promise<ReadonlyMap<number, number>>;
}

/** One reviewer's answer on one claim. */
export interface Verdict {
  reviewer: string;
  approve: boolean;
}

/** A tranche of a team member's Shares and what became of it. */
interface PromiseTranche extends MilestoneTranche {
  /** The claim that freed it, once it has been. */
  claimId: string | null;
  /** Unix seconds it was freed, when the block's time could be read. */
  reachedAt: number | null;
}

export interface TeamPromise {
  holder: string;
  /** What cannot move yet. */
  locked: bigint;
  tranches: PromiseTranche[];
}

/** Identifies a claim across mandates (two mandates have two claim books). Lower-case. */
export function claimKey(mandate: string, claimId: string): string {
  return `${mandate}:${claimId}`.toLowerCase();
}

export interface RecordEvents {
  /** Unix seconds each claim was filed, by `claimKey`. */
  filedAt: ReadonlyMap<string, number>;
  /** Unix seconds each claim was paid out, by `claimKey`. */
  paidAt: ReadonlyMap<string, number>;
  /** The transaction that paid each claim out, by `claimKey`, so a page can link it. */
  paidTx: ReadonlyMap<string, string>;
  /** What each reviewer said, by `claimKey`. */
  verdicts: ReadonlyMap<string, Verdict[]>;
  promises: TeamPromise[];
  /** The contract holding team Shares back, or null when the DAO has none. */
  lock: string | null;
  /** More history existed than was read. */
  truncated: boolean;
}

interface Parsed {
  topics: string[];
  data: string;
  block: number;
  tx: string | null;
}

function parse(raw: unknown): Parsed | null {
  if (raw === null || typeof raw !== "object") return null;
  const log = raw as {
    topics?: unknown;
    data?: unknown;
    blockNumber?: unknown;
    transactionHash?: unknown;
  };
  if (!Array.isArray(log.topics) || typeof log.data !== "string") return null;
  if (!log.topics.every((t) => typeof t === "string")) return null;
  let block = 0;
  try {
    block = Number(BigInt(String(log.blockNumber ?? "0x0")));
  } catch {
    return null;
  }
  const tx =
    typeof log.transactionHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)
      ? log.transactionHash
      : null;
  return { topics: log.topics as string[], data: log.data, block, tx };
}

/** The newest `MAX_RECORD_LOGS` entries of an event, oldest first, and whether older ones were left out. */
async function readLogs(
  chain: WorkChain,
  address: string,
  topics: (string | null)[],
): Promise<{ logs: Parsed[]; cut: boolean }> {
  const all = (await chain.logs({ address, topics }))
    .map(parse)
    .flatMap((p) => (p ? [p] : []));
  return {
    logs: all.slice(-MAX_RECORD_LOGS),
    cut: all.length > MAX_RECORD_LOGS,
  };
}

const addressFromTopic = (topic: string): string =>
  `0x${topic.slice(-40)}`.toLowerCase();
const word = (data: string, i: number): bigint =>
  BigInt(`0x${data.replace(/^0x/, "").slice(i * 64, (i + 1) * 64) || "0"}`);
const idOf = (topic: string): string => topic.toLowerCase();

/** The team's locked Shares: who holds them, which milestones are behind them, and which have been reached. */
export async function readTeamPromises(
  chain: WorkChain,
  dao: string,
): Promise<{
  promises: TeamPromise[];
  lock: string | null;
  unlockBlocks: Map<string, number>;
  cut: boolean;
}> {
  const empty = {
    promises: [],
    lock: null,
    unlockBlocks: new Map<string, number>(),
    cut: false,
  };
  const shares = decodeAddress(
    await chain.call(dao, encodeCall0(LOCK_SIGNATURES.daoShares)),
  );
  if (shares === ZERO_ADDRESS) return empty;
  const lock = decodeAddress(
    await chain.call(shares, encodeCall0(LOCK_SIGNATURES.sharesLockGuard)),
  );
  if (lock === ZERO_ADDRESS) return empty;

  // The team's Shares were minted to them when the DAO was made, so whoever received a mint is a candidate; the lock
  // itself says which of them have milestones behind their Shares.
  const mints = await readLogs(chain, shares, [TOPIC_TRANSFER, ZERO_TOPIC]);
  const holders = [
    ...new Set(
      mints.logs.flatMap((l) =>
        l.topics[2] ? [addressFromTopic(l.topics[2])] : [],
      ),
    ),
  ].slice(0, MAX_HOLDERS);
  const views = await Promise.all(
    holders.map((holder) => readMilestoneLock(chain, dao, holder)),
  );

  const unlocked = await readLogs(chain, lock, [TOPIC_UNLOCKED]);
  const freed = new Map<string, { claimId: string; block: number }>();
  const unlockBlocks = new Map<string, number>();
  for (const log of unlocked.logs) {
    const [, who, index] = log.topics;
    if (!who || !index) continue;
    const key = `${addressFromTopic(who)}:${Number(BigInt(index))}`;
    freed.set(key, {
      claimId: `0x${word(log.data, 1).toString(16).padStart(64, "0")}`,
      block: log.block,
    });
    unlockBlocks.set(key, log.block);
  }

  const promises: TeamPromise[] = [];
  for (const view of views) {
    if (!view || view.tranches.length === 0) continue;
    promises.push({
      holder: view.holder.toLowerCase(),
      locked: view.locked,
      tranches: view.tranches.map((t) => {
        const hit = freed.get(`${view.holder.toLowerCase()}:${t.index}`);
        return { ...t, claimId: hit?.claimId ?? null, reachedAt: null };
      }),
    });
  }
  return {
    promises,
    lock,
    unlockBlocks,
    cut: mints.cut || unlocked.cut,
  };
}

/** Everything the record shows that the work and decision reads do not already carry. */
export async function readRecordEvents(
  chain: RecordChain,
  work: WorkSnapshot,
): Promise<RecordEvents> {
  let truncated = false;
  const filedBlocks = new Map<string, number>();
  const paidBlocks = new Map<string, number>();
  const paidTx = new Map<string, string>();
  const verdicts = new Map<string, Verdict[]>();

  await Promise.all(
    work.mandates.map(async (mandate) => {
      const [filed, paid, attested] = await Promise.all([
        readLogs(chain, mandate.claimsAddress, [TOPIC_CLAIM_SUBMITTED]),
        readLogs(chain, mandate.claimsAddress, [TOPIC_CLAIM_PAID]),
        readLogs(chain, mandate.verifiersAddress, [TOPIC_ATTESTED]),
      ]);
      if (filed.cut || paid.cut || attested.cut) truncated = true;
      for (const log of filed.logs) {
        if (log.topics[1]) {
          filedBlocks.set(
            claimKey(mandate.address, idOf(log.topics[1])),
            log.block,
          );
        }
      }
      for (const log of paid.logs) {
        if (log.topics[1]) {
          const key = claimKey(mandate.address, idOf(log.topics[1]));
          paidBlocks.set(key, log.block);
          if (log.tx) paidTx.set(key, log.tx);
        }
      }
      for (const log of attested.logs) {
        const [, claim, reviewer] = log.topics;
        if (!claim || !reviewer) continue;
        const key = claimKey(mandate.address, idOf(claim));
        const list = verdicts.get(key) ?? [];
        list.push({
          reviewer: addressFromTopic(reviewer),
          approve: word(log.data, 0) !== 0n,
        });
        verdicts.set(key, list);
      }
    }),
  );

  const team = await readTeamPromises(chain, work.dao);
  if (team.cut) truncated = true;

  // One lookup per distinct block, newest first if there are too many.
  const wanted = [
    ...new Set([
      ...filedBlocks.values(),
      ...paidBlocks.values(),
      ...team.unlockBlocks.values(),
    ]),
  ]
    .sort((a, b) => b - a)
    .slice(0, MAX_BLOCKS);
  const times = wanted.length > 0 ? await chain.blockTimes(wanted) : new Map();
  const timed = (blocks: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [key, block] of blocks) {
      const t = times.get(block);
      if (t !== undefined) out.set(key, t);
    }
    return out;
  };

  const reached = timed(team.unlockBlocks);
  const promises = team.promises.map((p) => ({
    ...p,
    tranches: p.tranches.map((t) => ({
      ...t,
      reachedAt: reached.get(`${p.holder}:${t.index}`) ?? null,
    })),
  }));

  return {
    filedAt: timed(filedBlocks),
    paidAt: timed(paidBlocks),
    paidTx,
    verdicts,
    promises,
    lock: team.lock,
    truncated,
  };
}
