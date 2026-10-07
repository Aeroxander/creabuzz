/**
 * The scenes a story is made of. One is playable today — the funding status,
 * which is what this branch builds — and each feature lands with its own
 * scene (plan §9).
 *
 * Every step reads the four invariants even when it moves no money. That is
 * the point: they are the run's *continuous* conditions, so a scene cannot
 * quietly leave the treasury empty and still look like it worked.
 */

import { INVARIANTS } from "./invariants.ts";
import type { Story } from "./story.ts";

/**
 * The funding status, end to end (plan §2): what a project says about
 * raising, and what its own records prove, cannot contradict each other on a
 * card. Runs on a real relay alone — the outcome is a recorded receipt, not a
 * chain transaction — so it plays before the auction world is wired in.
 */
const FUNDING_STATUS_STEPS = [
  {
    actor: "founder",
    does: "publishes an idea and declares it is planning a raise, looking for backers",
    proves:
      "the card and the launch page say exactly that, and nothing claims a raise is open",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "opens the directory to find something to back",
    proves:
      "the chips count the launch under Planning a raise and under Backers, and the list does not present it as raising",
    checks: INVARIANTS,
  },
  {
    actor: "founder",
    does: "records that the raise ran and finished",
    proves:
      "the card moves on to Raise closed even though the record still declares Planning a raise",
    checks: INVARIANTS,
  },
  {
    actor: "founder",
    does: "redeclares the project as a rolling round with no end date",
    proves:
      "an open-ended round stays open-ended — a finished raise does not close it",
    checks: INVARIANTS,
  },
  {
    actor: "troublemaker",
    does: "publishes a second record for the same project claiming it is not raising while a raise is on file",
    proves:
      "the newest record wins and the chain correction still overrides a claim that cannot hold",
    checks: INVARIANTS,
  },
] as const;

/**
 * Proposal funding (plan §4): money goes where backers send it, not where the
 * team would have spent it. Runs on a real relay alone — the point of the
 * scene is what the surface promises *before* anything can be pledged, which
 * is exactly the moment a backer decides whether to trust it.
 */
const PROPOSAL_FUNDING_STEPS = [
  {
    actor: "founder",
    does: "declares that this project will fund itself through its backers' vault",
    proves:
      "the launch page offers the vault and says what it is for, in plain words",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "looks for a way to pledge before the vault exists",
    proves:
      "the page says the vault is not deployed yet and shows no control that could not act",
    checks: INVARIANTS,
  },
  {
    actor: "troublemaker",
    does: "tries to reach the pledge controls on a project that has no vault",
    proves:
      "there is nothing to click: a control that cannot act is never rendered",
    checks: INVARIANTS,
  },
] as const;

/**
 * Entry voice (plan §4, docs/token-voting-design.md §3): the mirror of
 * ragequit. Ragequit is the voice to leave; spending vouchers on a proposal is
 * the voice to enter. This scene MOVES MONEY, so it runs against a real chain
 * (`scripts/web-vault-e2e.sh`) — a client-only world could not perform it.
 */
const ENTRY_VOICE_STEPS = [
  {
    actor: "backer-1",
    does: "pledges currency to the vault and receives vouchers for it",
    proves:
      "the vouchers appear in the backer's own account, one per unit pledged, and the vault holds exactly what it owes",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "spends vouchers backing a proposal instead of letting the team choose",
    proves:
      "the money lands in that proposal's reserve, the tax reaches the treasury, and the backer's tokens are escrowed in the vault rather than handed over",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "looks at what their commitment bought them on that proposal",
    proves:
      "their voice on that decision is visible and grows with the commitment, while unspent vouchers still carry none",
    checks: INVARIANTS,
  },
  {
    actor: "troublemaker",
    does: "tries to take unspent vouchers back after backing",
    proves:
      "only the unspent part comes back: what is committed to a proposal stays with it",
    checks: INVARIANTS,
  },
] as const;

/**
 * Settlement (plan §4, docs/token-voting-design.md §6): what happens to
 * committed capital when the milestone is judged. A verified check releases
 * the tokens; a failed one refunds the money. A refund, not a slash — that is
 * the difference from `ClaimStake`'s rejected-claim path, and it is the thing
 * a backer needs to trust before committing anything.
 */
const SETTLEMENT_STEPS = [
  {
    actor: "verifier-1",
    does: "judges the milestone against the check that was written when it opened",
    proves:
      "the proposal resolves as verified, and the money already spent on the work stays with the work",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "takes the tokens the vault was holding for them",
    proves:
      "exactly what was escrowed arrives — no more, and none of it before the check passed",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "backs a second proposal that needs more than anyone puts behind it",
    proves:
      "the money is committed but stays below its minimum, so the work cannot start",
    checks: INVARIANTS,
  },
  {
    actor: "troublemaker",
    does: "tries to close that proposal before its deadline",
    proves: "a proposal that is still live is not an outsider's to close",
    checks: INVARIANTS,
  },
  {
    actor: "backer-1",
    does: "takes their money back once the deadline has passed below the minimum",
    proves:
      "it is a refund, not a slash: the treasury keeps only the tax it was already owed",
    checks: INVARIANTS,
  },
] as const;

export const STORY: Story = {
  title: "A whole project, start to finish",
  scenes: [
    {
      id: "funding-status",
      title: "The funding status is honest",
      proves:
        "every project shows an honest funding status, and a card cannot disagree with the records behind it",
      world: "client",
      steps: FUNDING_STATUS_STEPS,
    },
    {
      id: "proposal-funding",
      title: "Backers decide where the money goes",
      proves:
        "a project that funds itself through its backers' vault says so honestly, and never shows a control it cannot honour",
      world: "client",
      steps: PROPOSAL_FUNDING_STEPS,
    },
    {
      id: "entry-voice",
      title: "Entry voice: backing a proposal",
      proves:
        "spending vouchers is the voice to enter — capital reaches the proposal the backer chose, and nothing else",
      world: "chain",
      steps: ENTRY_VOICE_STEPS,
    },
    {
      id: "settlement",
      title: "Settlement: a verified check releases, a failed one refunds",
      proves:
        "committed capital ends up where the outcome says it should, and a backer who backed the wrong thing gets their money back",
      world: "chain",
      steps: SETTLEMENT_STEPS,
    },
  ],
};
