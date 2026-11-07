import * as React from "react";

import { useMyRelayMembershipLookupQuery } from "@/features/community-members/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";

import {
  buildBudgetSubjectOptions,
  canOfferCommunityDefault,
  type BudgetSubjectOption,
} from "../lib/budgetForm";
import { collectAgentSeats } from "../lib/nodeLiveness";
import type { OrgNode } from "../orgModels";

/**
 * Subject options for a new budget: the agents seated in the org (named via
 * their profile, labelled with their seat) plus, when the viewer may publish
 * it, "All agents (community default)". Shared by the budget form and the
 * org wizard so both publish the same subject the relay accepts.
 */
export function useBudgetSubjectOptions(nodes: readonly OrgNode[]): {
  options: BudgetSubjectOption[];
  /** False when the viewer is known not to be a community owner/admin. */
  communityDefaultAvailable: boolean;
} {
  const liveNodes = React.useMemo(
    () => nodes.filter((node) => !node.revoked),
    [nodes],
  );
  const agentKeys = React.useMemo(
    () => collectAgentSeats(liveNodes),
    [liveNodes],
  );
  const profiles = useUsersBatchQuery(agentKeys).data?.profiles;
  const membership = useMyRelayMembershipLookupQuery().data;
  const communityDefaultAvailable = canOfferCommunityDefault(membership);

  const options = React.useMemo(
    () =>
      buildBudgetSubjectOptions(liveNodes, {
        includeCommunityDefault: communityDefaultAvailable,
        resolveName: (pubkey, seats) =>
          resolveUserLabel({
            pubkey,
            profiles,
            fallbackName: seats[0],
          }),
      }),
    [liveNodes, communityDefaultAvailable, profiles],
  );

  return { options, communityDefaultAvailable };
}
