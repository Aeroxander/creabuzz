/**
 * Reading a project's backing pool (docs/v3-review/BACKING-POOL.md) for the Backing block, Home's feed and You.
 *
 * Which pool: the one `BackingPoolFactory.poolOf` names for the project's own DAO, where the DAO is the one in the
 * project's record and its start is checked against a kit's launch event. The factory's list of pools is never walked:
 * it holds strangers' DAOs next to real ones.
 *
 * Every read is bounded (a fixed number of calls, one log request with a cap), a read that does not complete throws so
 * the query keeps the last good view and says so, and nothing about a pool lives only in memory: the chain is the
 * record, and what a step sends is read back.
 */

import { addressTopic } from "@creaton/core/launchpad/work.ts";
import {
  type BackingChain,
  MAX_POOL_EVENTS,
  type PoolLog,
  readBuyQuote,
  readLeaveQuote,
  readPool,
  readPoolEvents,
  readSellQuote,
} from "@creaton/core/launchpad/backing.ts";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import {
  ethBlockNumber,
  ethBlockTimestamps,
  ethCall,
  ethChainId,
  ethGetLogs,
  getRpcEndpoint,
} from "./chain";
import { contributorKit, contributorKitV3 } from "./chain-config";
import { keepIfSame } from "./keep-previous";
import {
  type BackingRecord,
  type BackingTarget,
  backingRefreshMs,
  backingTarget,
} from "./lib/backing-target";
import {
  kitLaunchLogs,
  type Provenance,
  TOPIC_CONTRIBUTOR_LAUNCHED,
  TOPIC_CONTRIBUTOR_LAUNCHED_V3,
} from "./lib/contributor-status";

/** How many of a pool's newest blocks are dated: each is one lookup. */
const EVENT_DATES = 40;

/** Where every query about a backing pool lives, so a step sent from one re-reads them all. */
export const BACKING_QUERY = ["launchpad", "backing"] as const;

/** The configured endpoint as the pool reader's chain. */
export function backingChain(endpoint: string): BackingChain {
  return {
    call: (to, data) => ethCall(endpoint, to, data),
    blockNumber: async () => Number(await ethBlockNumber(endpoint)),
    now: async () => {
      const head = Number(await ethBlockNumber(endpoint));
      const [sample] = await ethBlockTimestamps(endpoint, [head]);
      if (!sample) throw new Error("the chain did not report its latest block");
      return sample.timestampSeconds;
    },
  };
}

/**
 * How a project's start is checked against the kits' launch events, as one query definition: the page's hook and the feed's
 * reads both use it, so a project is checked once and never again (the answer cannot change).
 */
export function provenanceQuery(chainId: string | null, dao: string | null) {
  const plain = contributorKit(chainId);
  const pooled = contributorKitV3(chainId);
  return {
    queryKey: [...BACKING_QUERY, "provenance", chainId, plain, pooled, dao],
    enabled: dao !== null && (plain !== null || pooled !== null),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<boolean> => {
      const topic = addressTopic(dao as string);
      const reads: Promise<readonly unknown[]>[] = [];
      if (plain !== null) {
        reads.push(
          kitLaunchLogs(
            (topics) =>
              ethGetLogs(getRpcEndpoint(), {
                address: plain,
                topics,
                fromBlock: "0x0",
                toBlock: "latest",
              }),
            topic,
          ),
        );
      }
      if (pooled !== null) {
        // The pool kit emits its own event, and the plain one when its plain launch is used.
        for (const event of [
          TOPIC_CONTRIBUTOR_LAUNCHED_V3,
          TOPIC_CONTRIBUTOR_LAUNCHED,
        ]) {
          reads.push(
            ethGetLogs(getRpcEndpoint(), {
              address: pooled,
              topics: [event, null, topic],
              fromBlock: "0x0",
              toBlock: "latest",
            }),
          );
        }
      }
      return (await Promise.all(reads)).some((logs) => logs.length > 0);
    },
  };
}

/**
 * Whether a kit this build names made the project's DAO, read from the kit's own launch event: the plain or weekly-sale
 * kit's, or the pool kit's. A record alone only claims it, and a record can name any DAO, so a pool is shown for a
 * project only once this says "kit". One read, kept: it never changes.
 */
function useBackingProvenance(
  chainId: string | null,
  dao: string | null,
): { provenance: Provenance; failed: boolean; retry: () => void } {
  const plain = contributorKit(chainId);
  const pooled = contributorKitV3(chainId);
  const query = useQuery(provenanceQuery(chainId, dao));
  const retry = () => void query.refetch();
  if (dao === null || (plain === null && pooled === null))
    return { provenance: "record", failed: false, retry };
  // A read that did not complete is not "no kit made it": it is said as a failed read, with a way to try again.
  if (query.isError && query.data === undefined)
    return { provenance: "reading", failed: true, retry };
  if (query.isLoading) return { provenance: "reading", failed: false, retry };
  return {
    provenance: query.data === true ? "kit" : "record",
    failed: false,
    retry,
  };
}

/**
 * One read of a project's pool for a wallet. A page that reads another network than the project's would find no pool
 * there: that is a wrong place to ask, not "no pool", so it is refused first.
 */
export async function readProjectPool(
  target: Extract<BackingTarget, { kind: "target" }>,
  wallet: string | null,
) {
  const endpoint = getRpcEndpoint();
  const chainId = Number(await ethChainId(endpoint));
  if (chainId !== target.chainId) {
    throw new Error(
      `This page reads network ${chainId}, but the project is on network ${target.chainId}.`,
    );
  }
  return readPool(backingChain(endpoint), {
    factory: target.factory,
    dao: target.dao,
    holder: wallet,
    expectedQuote: target.quoteToken,
  });
}

/**
 * A project's pool and the wallet's side of it. `target` says whether this project can have backing here at all; the
 * query is on only for a project whose start a kit's launch event confirms. `view` is the last good read: a read that
 * fails keeps it and sets `query.isError`, and the card says so.
 */
export function useBackingPool(
  record: BackingRecord | null,
  wallet: string | null,
) {
  const target: BackingTarget = record
    ? backingTarget(record)
    : { kind: "off" };
  const dao = target.kind === "target" ? target.dao : null;
  const {
    provenance,
    failed: provenanceFailed,
    retry: retryProvenance,
  } = useBackingProvenance(
    target.kind === "target" ? String(target.chainId) : null,
    dao,
  );
  // How many errors each query had when it last succeeded, so the backoff counts failures in a row.
  const calm = useRef(new Map<string, number>());
  const query = useQuery({
    queryKey: [...BACKING_QUERY, "pool", dao, wallet],
    enabled: target.kind === "target" && provenance === "kit",
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: keepIfSame(3, dao),
    refetchInterval: (q) => {
      const { status, data, errorUpdateCount } = q.state;
      if (status === "success") calm.current.set(q.queryHash, errorUpdateCount);
      const failures =
        status === "error"
          ? Math.max(errorUpdateCount - (calm.current.get(q.queryHash) ?? 0), 1)
          : 0;
      const busy =
        data?.kind === "pool" &&
        (data.phase === "waiting" || data.snapshot.milestone.status === "open");
      return backingRefreshMs(failures, busy);
    },
    queryFn: () => {
      if (target.kind !== "target") throw new Error("no project to read");
      return readProjectPool(target, wallet);
    },
  });
  return { target, provenance, provenanceFailed, retryProvenance, query };
}

/**
 * The pool's events from the build's history start: milestones, trades, the round. Cut when the pool has more than a read
 * keeps (`cut`), and says how many logs it could not read (`unreadable`). `wallet` is not part of the key: events are the
 * same for everyone.
 */
export function useBackingEvents(pool: string | null, chainId: number | null) {
  return useQuery({
    queryKey: [...BACKING_QUERY, "events", pool, chainId],
    enabled: pool !== null,
    staleTime: 20_000,
    refetchOnWindowFocus: false,
    placeholderData: keepIfSame(3, pool),
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
      const events = await readPoolEvents(
        async (filter) =>
          (await ethGetLogs(endpoint, {
            address: filter.address,
            topics: filter.topics,
            fromBlock: "0x0",
            toBlock: "latest",
          })) as readonly PoolLog[],
        pool as string,
        MAX_POOL_EVENTS,
      );
      // The date of each of the newest events: one bounded lookup. An older event is shown without a date, never with a
      // guessed one.
      const blocks = [...new Set(events.events.map((e) => e.block))].slice(
        0,
        EVENT_DATES,
      );
      const times = new Map(
        (await ethBlockTimestamps(endpoint, blocks)).map((s) => [
          s.block,
          s.timestampSeconds,
        ]),
      );
      return { ...events, times };
    },
  });
}

/**
 * What a buy of `quoteIn` would give right now, asked of the pool itself. Off with no amount. The key names the pool and
 * the amount, so a quote for another amount is never shown for this one; a failed ask throws and the form says so.
 */
export function useBuyQuote(pool: string | null, quoteIn: bigint | null) {
  return useQuery({
    queryKey: [
      ...BACKING_QUERY,
      "quote-buy",
      pool,
      quoteIn?.toString() ?? null,
    ],
    enabled: pool !== null && quoteIn !== null && quoteIn > 0n,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () =>
      readBuyQuote(
        backingChain(getRpcEndpoint()),
        pool as string,
        quoteIn as bigint,
      ),
  });
}

/** What the wallet selling `units` would get right now. */
export function useSellQuote(
  pool: string | null,
  holder: string | null,
  units: bigint | null,
) {
  return useQuery({
    queryKey: [
      ...BACKING_QUERY,
      "quote-sell",
      pool,
      holder,
      units?.toString() ?? null,
    ],
    enabled: pool !== null && holder !== null && units !== null && units > 0n,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () =>
      readSellQuote(
        backingChain(getRpcEndpoint()),
        pool as string,
        holder as string,
        units as bigint,
      ),
  });
}

/** What leaving at the open milestone would pay the wallet right now. Off unless the wallet may leave. */
export function useLeaveQuote(
  pool: string | null,
  holder: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...BACKING_QUERY, "quote-leave", pool, holder],
    enabled: enabled && pool !== null && holder !== null,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () =>
      readLeaveQuote(
        backingChain(getRpcEndpoint()),
        pool as string,
        holder as string,
      ),
  });
}
