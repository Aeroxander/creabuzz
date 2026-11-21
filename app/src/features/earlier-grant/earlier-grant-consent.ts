/**
 * PROVISIONAL, NEUTRAL, AND COUNSEL'S: every sentence on the earlier backers' claim page that asks for an acceptance, speaks of
 * consent, or says anything about permanence or an end date lives in this one file, so that counsel's words can replace it
 * without touching the page. These are placeholders, written to say only what the page does and what the contract does:
 * they promise nothing, say nothing is "for ever", say nothing about what the team can or cannot do to a grant, and say nothing about an end date (counsel has not set one). The page and
 * its tests import them from here and nowhere else; `pnpm check:copy` covers this file like any other.
 */

/** The label of the box a person ticks before the claim press is offered. A placeholder for counsel's words. */
export const CONSENT_LABEL = "I have read the text with this fingerprint.";

/** The claim press. */
export const CLAIM_BUTTON = "Accept the text and claim";

/** Under the press: what pressing it does, said plainly and promising nothing. */
export const CLAIM_RECORDS =
  "This records the fingerprint you name, from your account, on the network.";

/** What the page says about the grant once it is made: what the contract does, which counsel may reword. */
export function permanenceSentence(clock: string): string {
  return `They unlock evenly over ${clock} counted from the day the project began, with no waiting period at the start.`;
}
