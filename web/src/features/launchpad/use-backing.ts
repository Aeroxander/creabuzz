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
  readPool,
  readPoolEvents,
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
 * Whether a kit this build names made the project's DAO, read from the kit's own launch event: the plain or weekly-sale
 * kit's, or the pool kit's. A record alone only claims it, and a record can name any DAO, so a pool is shown for a
 * project only once this says "kit". One read, kept: it never changes.
 */
export function useBackingProvenance(
  chainId: string | null,
  dao: string | null,
): Provenance {
  const plain = contributorKit(chainId);
  const pooled = contributorKitV3(chainId);
  const query = useQuery({
    queryKey: [...BACKING_QUERY, "provenance", chainId, plain, pooled, dao],
    enabled: dao !== null && (plain !== null || pooled !== null),
    queryFn: async () => {
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
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  if (dao === null || (plain === null && pooled === null)) return "record";
  if (query.isLoading) return "reading";
  return query.data === true ? "kit" : "record";
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
  const provenance = useBackingProvenance(
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
    queryFn: async () => {
      if (target.kind !== "target") throw new Error("no project to read");
      const endpoint = getRpcEndpoint();
      // A page that reads another network than the project's would find no pool there: that is a wrong place to ask, not
      // "no pool".
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
    },
  });
  return { target, provenance, query };
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
