/**
 * Telling the site's organiser when sponsored fees stop working. A refused sponsorship (the gas policy's spending limit
 * spent, or an operation the policy does not cover) or a bundler that fails stops every passkey step for everyone, and
 * nobody on the page can fix it: the person sees a sentence (`actingErrorMessage`), and before this the error collector
 * heard nothing, because the failure was handled.
 *
 * `reportingSender` wraps the passkey account's sender where it is made (`use-acting-account.ts`), so every step sent
 * through it is covered once, and the error goes on to the caller unchanged. A passkey prompt the person closed is their
 * choice, not a fault, and is not reported. Each cause is told once a visit (`reportHandledFailure`).
 *
 * Alias-free: `sponsor-report.test.mjs` drives it under `node --test`.
 */

import type {
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import { PaymasterDeniedError } from "../../identity/lib/zerodev.ts";
import { reportHandledFailure } from "../../../shared/lib/error-report.ts";

/** What a failed sponsored send is reported as, or null when it is not the organiser's to hear about. */
export function sponsorFailureCause(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return null;
  if (error instanceof PaymasterDeniedError) return "sponsor-refused";
  const kind =
    typeof name === "string" && /^[A-Za-z][\w]{0,40}$/.test(name)
      ? name
      : "Error";
  return `sponsor-failed-${kind}`;
}

/** The same sender, whose failed sends are reported before they reach the caller unchanged. */
export function reportingSender<
  S extends { sendCalls(calls: SenderCall[]): Promise<SendCallsResult> },
>(sender: S, report: typeof reportHandledFailure = reportHandledFailure): S {
  return {
    ...sender,
    async sendCalls(calls: SenderCall[]): Promise<SendCallsResult> {
      try {
        return await sender.sendCalls(calls);
      } catch (error) {
        const cause = sponsorFailureCause(error);
        if (cause) report(cause, error);
        throw error;
      }
    },
  };
}
