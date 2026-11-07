import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useHomeFeedQuery } from "@/features/home/hooks";
import {
  evaluateGettingStarted,
  type GettingStartedStep,
} from "@/features/home/lib/gettingStarted";
import type { FeedItem } from "@/shared/api/types";

const EMPTY_FEED_ITEMS: FeedItem[] = [];

/**
 * Live inputs for the getting-started checklist (home + Settings surfaces).
 * All sources are shared react-query caches, so mounting on a second surface
 * reuses the same cached data instead of refetching.
 */
export function useGettingStartedSteps(
  currentPubkey: string | null | undefined,
): GettingStartedStep[] {
  const channels = useChannelsQuery().data;
  const feed = useHomeFeedQuery().data;
  const managedAgents = useManagedAgentsQuery({
    enabled: currentPubkey !== undefined,
  }).data;

  const feedItems = React.useMemo(() => {
    if (!feed) return EMPTY_FEED_ITEMS;
    return [
      ...feed.feed.mentions,
      ...feed.feed.needsAction,
      ...feed.feed.activity,
      ...feed.feed.agentActivity,
    ];
  }, [feed]);

  return React.useMemo(
    () =>
      evaluateGettingStarted({
        channels: channels ?? [],
        currentPubkey: currentPubkey ?? null,
        feedItems,
        managedAgentCount: managedAgents?.length ?? 0,
      }),
    [channels, currentPubkey, feedItems, managedAgents],
  );
}
