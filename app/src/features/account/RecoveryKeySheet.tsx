import {
  closeRecoveryOffer,
  pendingRecoveryOffer,
  subscribeRecoveryOffer,
} from "@creaton/core/account/recovery-offer.ts";
import { lazy, Suspense, useSyncExternalStore } from "react";
import { Sheet } from "../../ui/sheet";

// The key itself (and saving it to a file) loads when the offer is shown, not with the first screen.
const RecoveryKeyPanel = lazy(() =>
  import("./RecoveryKeyPanel").then((m) => ({ default: m.RecoveryKeyPanel })),
);

/** Shows the recovery key once a passkey account is made (the offer made by sign-up, `recovery-offer.ts`). */
export function RecoveryOfferHost() {
  const offer = useSyncExternalStore(
    subscribeRecoveryOffer,
    pendingRecoveryOffer,
    pendingRecoveryOffer,
  );
  const close = () => {
    if (!offer) return;
    closeRecoveryOffer(offer);
    offer.onClose();
  };
  return (
    <Sheet
      description="A passkey signs in only on this device."
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={offer !== null}
      testId="backup-sheet"
      title="Save your recovery key"
    >
      <Suspense fallback={null}>
        <RecoveryKeyPanel onSaved={close} />
      </Suspense>
    </Sheet>
  );
}
