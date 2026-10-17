/**
 * The agreement in one glance, on the project's Overview: what the team's locked tokens are released against. Each
 * milestone is listed with the words it is judged by and the tokens it holds back, from the launch record alone (no chain
 * read), and the Milestones tab holds the live story of each one.
 */

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { plannedMilestoneTokens } from "../lib/milestone-plan";
import { formatShares } from "../lib/shares-format";
import type { LaunchRecord } from "../models";
import { countOf } from "@/shared/lib/count-of";

export function MilestoneSummaryCard({
  record,
  onOpenMilestones,
}: {
  record: LaunchRecord;
  onOpenMilestones: () => void;
}) {
  const milestones = record.unlocks?.milestones ?? [];
  if (record.unlocks?.mode !== "milestones" || milestones.length === 0) {
    return null;
  }
  const tokens = plannedMilestoneTokens(record);
  return (
    <Card className="p-4 lg:col-span-2" data-testid="launch-milestone-summary">
      <h2 className="text-base font-semibold">
        The team&apos;s tokens unlock with{" "}
        {countOf(milestones.length, "milestone")}
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        The team&apos;s locked tokens are released one milestone at a time, when
        named reviewers approve the evidence for it. Each milestone is judged by
        exactly these words.
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
                ? `about ${formatShares(tokens[index] as bigint)} tokens`
                : `${milestone.percent}% of the locked tokens`}
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
