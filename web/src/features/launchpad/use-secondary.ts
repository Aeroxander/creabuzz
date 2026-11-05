import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import type { DescribeContext } from "@creaton/core/launchpad/daoActions.ts";

import { getRpcEndpoint } from "./chain";
import { secondaryMarketFactory } from "./chain-config";
import {
  olderBlockBefore,
  pollSecondary,
  readMarketForWords,
  readOlderBlock,
  readSecondaryView,
  type SecondaryMarketView,
} from "./lib/secondary-read";
import { endpointChain } from "./use-work";

/** Where every query about the secondary market lives, so a step sent from one re-reads it. */
export const SECONDARY_QUERY = ["launchpad", "secondary"] as const;

/**
 * The DAO's secondary market (docs/v3-review/SECONDARY-LISTING-SPEC.md), when
 * this build names its factory on the project's network: its listing terms, its
 * latest round, the connected wallet's orders in it, and the market's own lot
 * size and tokens so a price can be shown as money and an order approved.
 *
 * A factory this build does not name is not an absent market: the read is not
 * attempted and the card says trading is not set up here. A read that did not
 * complete throws, so the query keeps the last good view and retries — never
 * "this DAO has no market".
 */
export function useSecondary(input: {
  chainId: string | number | null;
  dao: string;
  wallet: string | null;
}) {
  const factory = secondaryMarketFactory(input.chainId);
  // How many errors each query had when it last succeeded, so the polling backoff counts failures in a row.
  const calm = useRef(new Map<string, number>());
  const query = useQuery({
    queryKey: [...SECONDARY_QUERY, input.dao, input.wallet, factory],
    enabled: factory !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    // A round closes and times out by the clock, with no one acting, so a card left open re-reads while one is live
    // and shows "Settle the round" the moment bidding ends; a finished round re-reads when the next may open; and a
    // read that failed is looked at again, slower each time, so a node coming back needs no reload.
    refetchInterval: (q) => pollSecondary(q, calm.current),
    // A read that did not complete throws (and so retries), keeping the last good view in the query.
    queryFn: (): Promise<SecondaryMarketView> =>
      readSecondaryView(endpointChain(getRpcEndpoint()), {
        factory: factory as string,
        dao: input.dao,
        wallet: input.wallet,
      }),
  });
  return { factory, query };
}

/**
 * The market a decision of this DAO may be aimed at, for `describeDecision`: a vote that publishes or stops a listing
 * is put in words only when it is aimed at this address, and its prices use this market's own price token. Undefined
 * while it is read, when this build names no market factory, when the DAO has none or the read failed, and every one
 * of those leaves a listing vote described as an action this app does not know.
 */
export function useSecondaryMarketForWords(input: {
  chainId: string | number | null;
  dao: string | null;
}): DescribeContext["secondaryMarket"] | undefined {
  const factory = secondaryMarketFactory(input.chainId);
  const dao = input.dao;
  const query = useQuery({
    queryKey: [...SECONDARY_QUERY, "words", dao, factory],
    enabled: factory !== null && dao !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      readMarketForWords(endpointChain(getRpcEndpoint()), {
        factory: factory as string,
        dao: dao as string,
      }),
  });
  return query.data ?? undefined;
}

/**
 * The older rounds the card did not check at first, one fixed block of ids per entry, in order: block 0 is the one just
 * below the card's own window and each next block the next ids down. The query key names the market, the wallet, the
 * latest round and the block's own bound, so a block read for another wallet or an earlier latest round is never taken
 * for this one, and a step the wallet sends (which invalidates `SECONDARY_QUERY`) re-reads them. `blocks` is how many
 * the person has asked for; each ask is one more bounded block, never all of them at once.
 */
export function useOlderRounds(input: {
  market: string;
  wallet: string | null;
  latest: bigint;
  unchecked: bigint;
  blocks: number;
}) {
  const { market, wallet, latest, unchecked } = input;
  const befores: bigint[] = [];
  for (let i = 0; i < input.blocks; i++) {
    const before = olderBlockBefore(unchecked, i);
    if (before === null) break;
    befores.push(before);
  }
  return useQueries({
    queries: befores.map((before) => ({
      queryKey: [
        ...SECONDARY_QUERY,
        "older",
        market,
        wallet,
        latest.toString(),
        before.toString(),
      ],
      enabled: wallet !== null,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      queryFn: () =>
        readOlderBlock(endpointChain(getRpcEndpoint()), {
          market,
          wallet: wallet as string,
          latest,
          before,
        }),
    })),
  });
}
