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
import { SponsoredSenderUnavailableError } from "../../identity/lib/sponsoredSender.ts";
import { PaymasterDeniedError } from "../../identity/lib/zerodev.ts";
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

/** Resolve the chosen sender — the only sender-dependent step of a send. */
export function resolveSender(state: SenderChoice): CallSender {
  return state.kind === "passkey"
    ? state.sponsoredSender
    : createInjectedWalletSender(state.wallet);
}

/** Map a send failure to a human message (the RecordBidDialog error map). */
export function senderErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof PaymasterDeniedError) {
    return `${err.serverMessage} ${err.dashboardAction}`;
  }
  if (
    err instanceof SponsoredSenderUnavailableError &&
    err.availability.action
  ) {
    return `${err.message} ${err.availability.action}`;
  }
  return err instanceof Error ? err.message : fallback;
}
