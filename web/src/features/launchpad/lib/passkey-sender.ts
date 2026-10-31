/**
 * The one way this app makes a passkey account's sender: sponsored by ZeroDev, with its failed sends told to the error
 * collector (`sponsor-report.ts`). Every place that sends as a passkey account makes it here, so none can forget the
 * report. It wraps `identity/lib/sponsoredSender.ts` (the ZeroDev sender itself); the names differ on purpose.
 *
 * Alias-free: `passkey-sender.test.mjs` drives it under `node --test`.
 */

import {
  createSponsoredSender,
  type SponsoredSender,
  type SponsoredSenderConfig,
} from "../../identity/lib/sponsoredSender.ts";
import { reportingSender } from "./sponsor-report.ts";

export function makeSponsoredSender(
  config: SponsoredSenderConfig,
  report?: Parameters<typeof reportingSender>[1],
): SponsoredSender {
  return reportingSender(createSponsoredSender(config), report);
}
