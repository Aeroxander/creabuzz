import * as React from "react";

import {
  readGettingStartedDismissed,
  writeGettingStartedDismissed,
} from "@/features/home/lib/gettingStarted";

/**
 * Dismissal state for the home "Getting started" checklist, persisted per
 * identity in localStorage. `restore` powers the Settings → Getting started
 * "Show on Home" affordance (Rule 6: hiding the card must never remove the
 * only way back).
 */
export function useGettingStartedDismissal(
  currentPubkey: string | null | undefined,
) {
  const normalizedPubkey = currentPubkey?.trim().toLowerCase() ?? "";
  const [dismissed, setDismissed] = React.useState<boolean>(() =>
    readGettingStartedDismissed(normalizedPubkey),
  );

  // Re-read when the identity changes so one account never inherits another
  // account's dismissal.
  React.useEffect(() => {
    setDismissed(readGettingStartedDismissed(normalizedPubkey));
  }, [normalizedPubkey]);

  const dismiss = React.useCallback(() => {
    writeGettingStartedDismissed(normalizedPubkey, true);
    setDismissed(true);
  }, [normalizedPubkey]);

  const restore = React.useCallback(() => {
    writeGettingStartedDismissed(normalizedPubkey, false);
    setDismissed(false);
  }, [normalizedPubkey]);

  return { dismiss, dismissed, restore };
}
