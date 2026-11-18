/**
 * One name per work-claim state, on the Work tab's chips.
 *
 * The chain's words say nothing about who did what: `Approved` is the end of a
 * review, not an award, and an `Open` claim a manager accepted is being
 * reviewed while an `Open` claim that is still unbound only waits for one.
 * These labels keep acceptance, the end of review and an award apart (D180's
 * reporting rule: accepted work, final review, awarded Shares and customer
 * outcomes stay distinct), so a person can never read "the reviewers
 * approved" as "I was awarded Shares".
 *
 * Shares appear only when the project's DAO carries an award on chain — the
 * Contributions tab shows those, from the events that moved them. A money
 * chip says only that money moved.
 *
 * Alias-free so `work-status.test.mjs` binds it under `node --test`.
 */

import { claimStatusLabel } from "@creaton/core/launchpad/work.ts";
import type { ClaimStatus } from "@creaton/core/launchpad/work.ts";

/**
 * A submission's status as the Work tab's chip reads it: "Submitted" before a
 * manager accepts it for review, "In review" once they have, "Review complete"
 * once the reviewers finished, and the shared words for the rest.
 */
export function workClaimStatus(
  record: { status: ClaimStatus; amount: bigint },
  accepted: boolean,
): string {
  if (record.status === "Open") return accepted ? "In review" : "Submitted";
  if (record.status === "Approved") return "Review complete";
  return claimStatusLabel(record);
}
