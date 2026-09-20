import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";
import { markHiddenDmFeedItems } from "@/features/channels/dmResurface";
import { useHiddenDmIds } from "@/features/channels/useHiddenDmIds";
import { useHomeFeedQuery } from "@/features/home/hooks";
import {
  mergeNeedsMeRequests,
  type NeedsMeApprovalActions,
} from "@/features/home/lib/needsMe";
import {
  useNeedsMeApprovals,
  useResolveNeedsMeApproval,
} from "@/features/home/useNeedsMeApprovals";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { HomeView } from "@/features/home/ui/HomeView";
import type { HomeFeedResponse } from "@/shared/api/types";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_MESSAGE,
} from "@/shared/lib/relayError";

type HomeScreenProps = {
  availableChannelIds: ReadonlySet<string>;
  currentPubkey?: string;
  onOpenContext: (
    channelId: string,
    messageId: string,
    threadRootId?: string | null,
  ) => void;
};

export function HomeScreen({
  availableChannelIds,
  currentPubkey,
  onOpenContext,
}: HomeScreenProps) {
  const homeFeedQuery = useHomeFeedQuery();
  const { threadActivityFeedItems } = useAppShell();
  const hiddenDmIds = useHiddenDmIds(currentPubkey);
  // Budget overrun requests address the budgeted AGENT (`p` = subject), so
  // the read includes the managed agents' keys — an owner must see that their
  // agent hit its budget ("does it need me").
  const managedAgents = useManagedAgentsQuery({
    enabled: currentPubkey !== undefined,
  }).data;
  const ownedAgentPubkeys = React.useMemo(
    () => (managedAgents ?? []).map((agent) => normalizePubkey(agent.pubkey)),
    [managedAgents],
  );
  const needsMe = useNeedsMeApprovals({ currentPubkey, ownedAgentPubkeys });
  const resolveApproval = useResolveNeedsMeApproval(currentPubkey);

  // Depend on the stable mutate method, not the mutation object — a fresh
  // useMutation result each render would defeat this memo (AGENTS gotcha 6).
  const resolveApprovalMutate = resolveApproval.mutate;
  const needsMeItems = needsMe.items;
  const approvalActions = React.useMemo((): NeedsMeApprovalActions => {
    const resolvingEventIds = new Set(
      needsMeItems
        .filter((item) => item.status === "resolving")
        .map((item) => item.id),
    );
    return {
      resolve: (approval, approved) => {
        resolveApprovalMutate({
          tokenHash: approval.tokenHash,
          approved,
        });
      },
      resolvingEventIds,
    };
  }, [needsMeItems, resolveApprovalMutate]);

  const augmentedFeed = React.useMemo((): HomeFeedResponse | undefined => {
    if (!homeFeedQuery.data) return undefined;
    const withThreadActivity =
      threadActivityFeedItems.length === 0
        ? homeFeedQuery.data
        : {
            ...homeFeedQuery.data,
            feed: {
              ...homeFeedQuery.data.feed,
              activity: [
                ...homeFeedQuery.data.feed.activity,
                ...threadActivityFeedItems,
              ],
            },
          };
    const withNeedsMe = mergeNeedsMeRequests(
      withThreadActivity,
      needsMe.pendingRequestEvents,
      needsMe.resolvedEventIds,
    );
    return markHiddenDmFeedItems(withNeedsMe, hiddenDmIds);
  }, [
    hiddenDmIds,
    homeFeedQuery.data,
    needsMe.pendingRequestEvents,
    needsMe.resolvedEventIds,
    threadActivityFeedItems,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <HomeView
        approvalActions={approvalActions}
        availableChannelIds={availableChannelIds}
        currentPubkey={currentPubkey}
        errorMessage={
          homeFeedQuery.error !== null && homeFeedQuery.error !== undefined
            ? isRelayUnreachableError(homeFeedQuery.error)
              ? RELAY_UNREACHABLE_MESSAGE
              : homeFeedQuery.error instanceof Error
                ? homeFeedQuery.error.message
                : undefined
            : undefined
        }
        feed={augmentedFeed}
        isLoading={homeFeedQuery.isLoading}
        onOpenContext={onOpenContext}
        onRefresh={() => {
          void homeFeedQuery.refetch();
        }}
      />
    </div>
  );
}
