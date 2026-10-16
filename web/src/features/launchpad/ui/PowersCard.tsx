/**
 * What the holders and the team can and cannot change, on the launch page of a project that has its own DAO.
 *
 * A lock on the team's Shares is not a promise that nobody can ever do anything else with the project's money. The page
 * says both halves in plain words, before a backer bids: what no vote can undo, what the holders can still decide (the
 * team votes too, from the first day), and what protects someone who is outvoted. Each line is true of the contracts the
 * launch creates; the starting rules are the DAO's to change by vote, and the card says so.
 */

import { Card } from "@/shared/ui/card";

const LOCKED = [
  "The team's locked Shares unlock only when the named reviewers approve each milestone. The lock is set once, at launch.",
  "Until then they cannot be sold, moved, or taken out by leaving the DAO.",
  "Who judges the milestones is named at launch, with how many must agree. A vote cannot swap in a different panel.",
  "No decision of any kind can be opened before the buyers can claim their tokens.",
] as const;

const VOTABLE = [
  "Spend the money the DAO holds.",
  "Issue new Shares.",
  "Turn leaving with your share of the treasury on or off.",
  "Give up a team member's unearned Shares. They are burned, never released for sale.",
  "Change the voting rules themselves: how many must vote, how many must agree, and how long a decision waits.",
] as const;

export function PowersCard() {
  return (
    <Card className="p-4" data-testid="launch-powers">
      <h2 className="text-base font-semibold">
        What can and cannot be changed
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        The lock on the team&apos;s Shares is a real commitment, but it is not
        the only thing that decides what happens to the money. Read both halves
        before you bid.
      </p>
      <h3 className="mt-3 text-sm font-medium">No vote can undo</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {LOCKED.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3 className="mt-3 text-sm font-medium">
        The holders can change by vote
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        The team votes too, with its locked Shares, from the first day.
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {VOTABLE.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3 className="mt-3 text-sm font-medium">
        If a decision goes against you
      </h3>
      <p className="mt-1 text-sm">
        Every decision waits through a review period and a delay before it runs.
        Until it runs, you can leave with your share of what the DAO holds, as
        long as leaving is switched on. Money already moved into a work budget
        is not part of that share.
      </p>
    </Card>
  );
}
