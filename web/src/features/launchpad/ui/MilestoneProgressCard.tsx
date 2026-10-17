/**
 * Where the team's milestones stand, on the DAO's front page: one line each, with the stage, and a way into the full
 * timeline. It reads what the Milestones tab reads, so the two never disagree; while the chain is being read, or could not
 * be, it says so rather than showing every milestone as not started.
 */

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import type { TimelineEntry } from "../lib/milestone-timeline";
import { formatShares } from "../lib/shares-format";
import type { Launch } from "../models";
import { useMilestoneTimeline } from "../use-milestone-timeline";

const STAGE_WORDS: Record<TimelineEntry["stage"], string> = {
  agreed: "Agreed",
  "not-submitted": "Not submitted",
  filed: "Filed",
  reviewing: "With the reviewers",
  reviewed: "Reviewed",
  waiting: "Waiting period",
  finish: "Ready to finish",
  ready: "Ready to release",
  unlocked: "Unlocked",
  frozen: "Frozen",
  "turned-down": "Turned down",
  "given-up": "Given up",
};

export function MilestoneProgressCard({
  launch,
  dao,
  onOpen,
}: {
  launch: Launch;
  dao: string;
  onOpen: () => void;
}) {
  const { entries, summary, reading, failed } = useMilestoneTimeline(
    launch,
    dao,
  );
  if (launch.record.unlocks?.mode !== "milestones" || entries.length === 0) {
    return null;
  }
  return (
    <Card className="p-4" data-testid="dao-milestones">
      <h3 className="text-sm font-semibold">The team&apos;s milestones</h3>
      {reading ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Reading the milestones…
        </p>
      ) : failed ? (
        <p
          className="mt-1 text-sm text-amber-800 dark:text-amber-200"
          data-testid="dao-milestones-failed"
        >
          Could not read where the milestones stand just now.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="dao-milestones-summary">
            {summary.reached} of {summary.total} reached.{" "}
            {formatShares(summary.heldBack)} tokens still locked
            {summary.released > 0n
              ? `, ${formatShares(summary.released)} released`
              : ""}
            .
          </p>
          <ol className="mt-2 divide-y divide-border/60 text-sm">
            {entries.map((entry) => (
              <li
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5"
                data-testid={`dao-milestone-${entry.index}`}
                key={entry.index}
              >
                <span className="min-w-0 flex-1">
                  {entry.index + 1}. {entry.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {STAGE_WORDS[entry.stage]}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      <Button
        className="mt-2"
        data-testid="dao-milestones-open"
        onClick={onOpen}
        size="sm"
        variant="outline"
      >
        See each milestone in full
      </Button>
    </Card>
  );
}
