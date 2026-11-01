/**
 * The agreement in one glance, on the project's Overview: what the team's locked Shares are released against. Each
 * milestone is listed with the words it is judged by and the Shares it holds back, from the launch record alone (no chain
 * read), and the Milestones tab holds the live story of each one.
 */

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { plannedMilestoneTokens } from "../lib/milestone-plan";
import { span } from "../lib/challenge-copy";
import { formatShares } from "../lib/shares-format";
import { isEvmAddress, type LaunchRecord } from "../models";
import { lockKindOf, useChallengeLock } from "../use-challenge-lock";
import { countOf } from "@/shared/lib/count-of";

export function MilestoneSummaryCard({
  record,
  onOpenMilestones,
}: {
  record: LaunchRecord;
  onOpenMilestones: () => void;
}) {
  const milestones = record.unlocks?.milestones ?? [];
  // How the milestones are judged is read from the project's own lock, so the agreement says the rule it really has.
  const dao =
    record.tokenPlan?.mode === "dao" &&
    record.treasury &&
    isEvmAddress(record.treasury)
      ? record.treasury
      : null;
  const lockRead = useChallengeLock(dao);
  const kind = lockKindOf(dao, lockRead);
  const lock = kind === "challenge" ? (lockRead.data ?? null) : null;
  if (record.unlocks?.mode !== "milestones" || milestones.length === 0) {
    return null;
  }
  const tokens = plannedMilestoneTokens(record);
  return (
    <Card className="p-4 lg:col-span-2" data-testid="launch-milestone-summary">
      <h2 className="text-base font-semibold">
        The team&apos;s Shares unlock with{" "}
        {countOf(milestones.length, "milestone")}
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Each milestone unlocks part of the team&apos;s locked Shares when the
        team shows it was reached and the project&apos;s rule for judging it is
        satisfied. Each milestone is judged by exactly these words.
      </p>
      <p className="mt-1 text-sm" data-testid="launch-milestone-rule">
        {kind === "challenge" && lock
          ? `How they are judged: holders can object. The team publishes evidence and posts a bond; its Shares unlock after the objection period (${span(lock.terms.window)} to start with, longer for a bigger milestone or a retry) unless holders successfully challenge the claim. Milestones go in order, each only once the one before has had its time for late objections.`
          : kind === "panel"
            ? "How they are judged: named reviewers read the evidence and approve each milestone, and a waiting period follows in which anyone can object."
            : kind === "unreadable"
              ? "How they are judged could not be read just now."
              : "How they are judged is chosen when the project launches: holders can object, or named reviewers approve. It is shown here from then on."}
      </p>
      <ol className="mt-3 divide-y divide-black/10 text-sm dark:divide-white/10">
        {milestones.map((milestone, index) => (
          <li
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
            data-testid={`launch-milestone-summary-${index}`}
            key={milestone.claim}
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium">{index + 1}. </span>
              {milestone.label}
            </span>
            <span className="text-xs text-black/60 tabular-nums dark:text-white/60">
              {tokens[index] !== null && tokens[index] !== undefined
                ? `about ${formatShares(tokens[index] as bigint)} Shares`
                : `${milestone.percent}% of the locked Shares`}
            </span>
          </li>
        ))}
      </ol>
      <Button
        className="mt-3"
        data-testid="launch-milestone-summary-open"
        onClick={onOpenMilestones}
        size="sm"
        variant="outline"
      >
        See where each one stands
      </Button>
    </Card>
  );
}
