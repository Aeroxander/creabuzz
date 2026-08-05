import * as React from "react";

import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import { registerSiwe } from "@/shared/api/siwe";

// SIWE chain id for the message. Must match the relay's `BUZZ_EVM_CHAIN_ID`.
// The Rust `siwe_config` default is Sepolia (11155111); keep in sync.
const DEFAULT_SIWE_CHAIN_ID = 11155111;

/**
 * Drive the `siwe-registering` stage after machine onboarding completes:
 * register the current identity against the transaction's relay via SIWE,
 * then advance to `connecting` so the existing add-community handler runs.
 *
 * Completion is fenced by transaction ID so cancelling or replacing the
 * transaction while the request is pending cannot mutate the replacement.
 * A failed registration parks on the caller's Retry affordance — without the
 * error guard the effect refires on the error-bearing transaction and loops.
 */
export function useSiweRegister() {
  const { transaction, update } = useCommunityOnboarding();
  const [isPending, setIsPending] = React.useState(false);

  React.useEffect(() => {
    if (
      transaction?.stage !== "siwe-registering" ||
      transaction.error ||
      isPending
    ) {
      return;
    }
    setIsPending(true);
    void registerSiwe(transaction.relayUrl, DEFAULT_SIWE_CHAIN_ID)
      .then((result) => {
        update(
          {
            stage: "connecting",
            siweAddress: result.evm_address,
            error: undefined,
          },
          transaction.id,
        );
      })
      .catch((error: unknown) =>
        update(
          {
            error:
              error instanceof Error
                ? error.message
                : "SIWE registration failed",
          },
          transaction.id,
        ),
      )
      .finally(() => setIsPending(false));
  }, [isPending, transaction, update]);
}
