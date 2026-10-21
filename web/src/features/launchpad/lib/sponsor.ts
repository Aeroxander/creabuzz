/** A suggestion someone is putting to a vote: the Decisions tab opens "Approve a project" filled in from it (D84). */
export interface SponsorIntent {
  /** The suggestion (board post) it came from. */
  proposalId: string;
  /** Who suggested it: they file the claims once it is approved. */
  proposer: string;
  name: string;
  /** Whole Shares. */
  shares: string;
  check: string;
}
