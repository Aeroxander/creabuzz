/**
 * Reading backing for Home's feed (`lib/backing-feed.ts`): for each project in view that can have a pool, its pool's
 * events, kept to the newest few and dated, and the pool's token for the amounts.
 *
 * Which pools: only those the factory names for a project's own DAO, and only for a project a kit's launch event confirms
 * (the same check the project's page makes, shared through one query so it is made once). The reads are bounded: at most
 * `BACKING_FEED_PROJECTS` projects, one log request and one lookup of at most `DATED_BLOCKS` block dates for each. A read
 * that fails for a project is counted and said, never shown as "no backing", and a bound that cut the read is said too.
 */

import {
  readPoolAddress,
  readPoolEvents,
  readPoolQuoteFacts,
} from "@creaton/core/launchpad/backing.ts";
import type { PoolLog } from "@creaton/core/launchpad/backing.ts";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  ethBlockTimestamps,
  ethGetLogs,
  getRpcEndpoint,
} from "@/features/launchpad/chain";
import { backingTarget } from "@/features/launchpad/lib/backing-target";
import { investingOffered } from "@/features/launchpad/lib/investing-offered";
import {
  type LaunchRecord,
  launchCoordinate,
} from "@/features/launchpad/models";
import {
  BACKING_QUERY,
  backingChain,
  provenanceQuery,
} from "@/features/launchpad/use-backing";

import { type BackingFeedPool, backingFeedItems } from "./lib/backing-feed";
import type { FeedScope } from "./use-record-feed";

/** The most projects whose backing one feed reads at once. */
const BACKING_FEED_PROJECTS = 12;
/** The newest blocks whose dates are looked up for each pool: each is one request. */
const DATED_BLOCKS = 16;
/** How many events one pool keeps in the feed's read. */
const EVENTS_KEPT = 120;

export function useBackingFeed(scope: FeedScope | null) {
  const on = investingOffered();
  const client = useQueryClient();
  const targets = useMemo(() => {
    if (!on || !scope) return [];
    const found: {
      record: LaunchRecord;
      chainId: number;
      factory: string;
      dao: string;
    }[] = [];
    for (const record of scope.projects) {
      const target = backingTarget(record);
      if (target.kind === "target")
        found.push({
          record,
          chainId: target.chainId,
          factory: target.factory,
          dao: target.dao,
        });
    }
    return found;
  }, [on, scope]);
  const read = targets.slice(0, BACKING_FEED_PROJECTS);
  const results = useQueries({
    queries: read.map((t) => ({
      queryKey: [...BACKING_QUERY, "feed", t.chainId, t.factory, t.dao],
      staleTime: 90_000,
      refetchInterval: 180_000,
      refetchOnWindowFocus: false,
      queryFn: async (): Promise<BackingFeedPool | null> => {
        const confirmed = await client.fetchQuery(
          provenanceQuery(String(t.chainId), t.dao),
        );
        if (!confirmed) return null;
        const endpoint = getRpcEndpoint();
        const chain = backingChain(endpoint);
        const pool = await readPoolAddress(chain, t.factory, t.dao);
        if (pool === null) return null;
        const quote = await client.fetchQuery({
          queryKey: [...BACKING_QUERY, "pool-quote", pool],
          staleTime: Number.POSITIVE_INFINITY,
          queryFn: () => readPoolQuoteFacts(chain, pool),
        });
        const { events } = await readPoolEvents(
          async (filter) =>
            (await ethGetLogs(endpoint, {
              address: filter.address,
              topics: filter.topics,
              fromBlock: "0x0",
              toBlock: "latest",
            })) as readonly PoolLog[],
          pool,
          EVENTS_KEPT,
        );
        const blocks = [...new Set(events.map((e) => e.block))].slice(
          0,
          DATED_BLOCKS,
        );
        const times = new Map(
          (await ethBlockTimestamps(endpoint, blocks)).map((s) => [
            s.block,
            s.timestampSeconds,
          ]),
        );
        return {
          coordinate: launchCoordinate(t.record.author, t.record.id),
          pool,
          quote,
          events,
          times,
        };
      },
    })),
  });
  const pools = results.flatMap((r) => (r.data ? [r.data] : []));
  // Cheap (at most a dozen pools of a bounded number of events), so worked out each time.
  const items = backingFeedItems(pools, Math.floor(Date.now() / 1000));
  const failed = results.filter((r) => r.isError).length;
  return {
    items,
    loading: results.some((r) => r.isLoading),
    failed,
    retry: () => {
      for (const r of results) if (r.isError) void r.refetch();
    },
    /** More projects could have backing than one feed reads. */
    cut: targets.length > BACKING_FEED_PROJECTS,
  };
}
