import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import type { DescribeContext } from "@creaton/core/launchpad/daoActions.ts";

import { getRpcEndpoint } from "./chain";
import { secondaryMarketFactory } from "./chain-config";
import {
  pollSecondary,
  readMarketForWords,
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
