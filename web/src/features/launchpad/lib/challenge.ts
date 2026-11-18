/**
 * "I doubt this claim": the step from a claim card to the form that puts a freeze (or, for a frozen claim, an unwind) to a
 * vote, with that claim already chosen. Carrying it as a small record keeps the Work tab and the Decisions tab apart.
 */

export interface ChallengeIntent {
  kind: "freeze" | "unwind";
  /** The work budget (mandate) the claim is in. */
  mandate: string;
  claimId: string;
}

/** The claim states a decision can still act on, and which decision that is; null for a claim nothing can be done about. */
export function challengeFor(status: string): ChallengeIntent["kind"] | null {
  if (status === "Open" || status === "Approved") return "freeze";
  if (status === "Frozen") return "unwind";
  return null;
}

/** The key the claim-picking forms use for one claim. */
export function challengePickKey(intent: ChallengeIntent): string {
  return `${intent.mandate.toLowerCase()}:${intent.claimId}`;
}
