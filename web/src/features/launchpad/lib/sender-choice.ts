/**
 * Sender choice for the launchpad money actions: the pure mapping from the
 * picker's state to a {@link CallSender}, plus the send-failure message map.
 * Extracted from `ui/SenderPicker.tsx` so `node --test` can bind the choice
 * seam (`.tsx` is not strip-types runnable) — `lib/exit-claim.test.mjs`'s
 * isAvailable truth table drives it.
 */
import type {
  CallSender,
  SponsoredSender,
} from "../../identity/lib/sponsoredSender.ts";
import {
  actingErrorMessage,
  requireSponsoredSuccess,
} from "./acting-account.ts";
import {
  createInjectedWalletSender,
  type Eip1193ProviderLike,
} from "./wallet-sender.ts";

export type SenderKind = "wallet" | "passkey";

/** The sender-choice input (the picker state's relevant slice). */
export interface SenderChoice {
  kind: SenderKind;
  wallet: Eip1193ProviderLike | undefined;
  sponsoredSender: SponsoredSender;
}

/**
 * Resolve the chosen sender — the only sender-dependent step of a send. A passkey account's operation is included on
 * chain even when a call inside it fails, so its result is checked here, once for every screen: a failed operation
 * throws `StepRevertedError` instead of reading as sent (D139).
 */
export function resolveSender(
  state: SenderChoice,
): CallSender & { via?: CallSender } {
  if (state.kind !== "passkey") {
    return createInjectedWalletSender(state.wallet);
  }
  const sponsored = state.sponsoredSender;
  return {
    /** The sponsored sender this one sends through. */
    via: sponsored,
    getAddress: () => sponsored.getAddress(),
    isAvailable: () => sponsored.isAvailable(),
    sendCalls: async (calls) => {
      const result = await sponsored.sendCalls(calls);
      requireSponsoredSuccess(result);
      return result;
    },
  };
}

/**
 * A send failure in plain words: `actingErrorMessage`'s, so every money panel says the same thing for the same failure
 * and never a vendor's dashboard or a bundler's error. `fallback` is for a thrown value that is not an error at all.
 */
export function senderErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? actingErrorMessage(err) : fallback;
}
