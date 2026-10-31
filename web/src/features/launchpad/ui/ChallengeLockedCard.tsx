import { Card } from "@/shared/ui/card";

import { CHALLENGE_STAGE_LABEL } from "../lib/challenge-copy";
import type { ChallengeLockView } from "@creaton/core/launchpad/milestoneChallenge.ts";
import { formatShares } from "../lib/shares-format";
import { hashText } from "@creaton/core/launchpad/work.ts";
import type { Launch } from "../models";

/**
 * A team member's view of their locked Shares when the project's milestones unlock unless holders object. There is nothing
 * to file here (no claim, no reviewers): each milestone is published from the Milestones tab, where holders can object.
 */
export function ChallengeLockedCard({
  view,
  launch,
}: {
  view: ChallengeLockView;
  launch: Launch;
}) {
  const words = new Map(
    (launch.record.unlocks?.milestones ?? []).map((m) => [
      hashText(m.label).toLowerCase(),
      m.label.trim(),
    ]),
  );
  return (
    <Card className="p-4" data-testid="challenge-locked-shares">
      <h3 className="text-sm font-semibold">Your team Shares</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        These Shares are yours and count when the DAO votes. The part tied to a
        milestone cannot be sold or taken out of the DAO until that milestone is
        reached. You publish each milestone on the Milestones tab; holders then
        have time to object.
      </p>
      <p className="mt-2 text-sm" data-testid="challenge-locked-total">
        {view.locked === 0n
          ? "Nothing is locked any more."
          : `${formatShares(view.locked)} Shares are still locked across the team.`}
      </p>
      <ol aria-label="Milestones" className="mt-2 flex flex-col gap-1 text-sm">
        {view.milestones.map((m) => (
          <li
            className="flex flex-wrap items-baseline justify-between gap-x-3"
            key={m.index}
          >
            <span className="min-w-0 flex-1">
              {m.index + 1}. {words.get(m.checkHash) ?? "Milestone"}
            </span>
            <span className="text-xs text-muted-foreground">
              {CHALLENGE_STAGE_LABEL[m.stage]}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
