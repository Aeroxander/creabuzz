import { useSyncExternalStore } from "react";

import {
  closeRecoveryOffer,
  pendingRecoveryOffer,
  subscribeRecoveryOffer,
} from "../lib/recovery-offer";
import { RecoveryKeyDialog } from "./RecoveryKeyDialog";

/**
 * Shows the recovery-key offer made right after a passkey sign-up (`lib/recovery-offer.ts`). Mounted once at the app's
 * root, so the offer stays open however the page that started sign-up re-renders.
 */
export function RecoveryOfferHost() {
  const offer = useSyncExternalStore(
    subscribeRecoveryOffer,
    pendingRecoveryOffer,
  );
  if (!offer) return null;
  return (
    <RecoveryKeyDialog
      account={offer.account}
      closeLabel="Done"
      intro="Your account is ready."
      key={offer.account}
      onClose={() => closeRecoveryOffer(offer)}
    />
  );
}
