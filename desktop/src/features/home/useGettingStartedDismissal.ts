import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  gettingStartedCommunityScope,
  readGettingStartedDismissed,
  writeGettingStartedDismissed,
} from "@/features/home/lib/gettingStarted";

/**
 * Dismissal state for the home "Getting started" checklist, persisted per
 * community AND identity in localStorage. `restore` powers the Settings →
 * Getting started "Show on Home" affordance (Rule 6: hiding the card must
 * never remove the only way back).
 */
export function useGettingStartedDismissal(
  currentPubkey: string | null | undefined,
) {
  const { activeCommunity } = useCommunities();
  const communityScope = gettingStartedCommunityScope(
    activeCommunity?.relayUrl,
  );
  const normalizedPubkey = currentPubkey?.trim().toLowerCase() ?? "";
  const [dismissed, setDismissed] = React.useState<boolean>(() =>
    readGettingStartedDismissed(communityScope, normalizedPubkey),
  );

  // Re-read when the community or identity changes so one account (or one
  // community) never inherits another's dismissal.
  React.useEffect(() => {
    setDismissed(readGettingStartedDismissed(communityScope, normalizedPubkey));
  }, [communityScope, normalizedPubkey]);

  const dismiss = React.useCallback(() => {
    writeGettingStartedDismissed(communityScope, normalizedPubkey, true);
    setDismissed(true);
  }, [communityScope, normalizedPubkey]);

  const restore = React.useCallback(() => {
    writeGettingStartedDismissed(communityScope, normalizedPubkey, false);
    setDismissed(false);
  }, [communityScope, normalizedPubkey]);

  return { dismiss, dismissed, restore };
}
