/**
 * Where the team's milestones stand, on the DAO's front page: one line each, with the stage, and a way into the full
 * timeline. It reads what the Milestones tab reads, so the two never disagree; while the chain is being read, or could not
 * be, it says so rather than showing every milestone as not started.
 */

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { CHALLENGE_STAGE_LABEL } from "../lib/challenge-copy";
import type { TimelineEntry } from "../lib/milestone-timeline";
import { formatShares } from "../lib/shares-format";
import type { Launch } from "../models";
import { hashText } from "../lib/work";
import { useChallengeLock } from "../use-challenge-lock";
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
  const challenge = useChallengeLock(dao);
  if (launch.record.unlocks?.mode !== "milestones" || entries.length === 0) {
    return null;
  }
  // When the lock lets holders object, the rows come from that lock, not from a panel's claims.
  const lock = challenge.data;
  if (lock) {
    const planned = launch.record.unlocks?.milestones ?? [];
    return (
      <Card className="p-4" data-testid="dao-milestones">
        <h3 className="text-sm font-semibold">The team&apos;s milestones</h3>
        <p className="mt-1 text-sm" data-testid="dao-milestones-summary">
          {lock.milestones.filter((m) => m.phase === "stood").length} of{" "}
          {lock.milestones.length} unlocked. {formatShares(lock.locked)} tokens
          still locked.
        </p>
        <ol className="mt-2 divide-y divide-border/60 text-sm">
          {lock.milestones.map((m) => {
            const words = planned
              .map((p) => p.label.trim())
              .find((label) => hashText(label).toLowerCase() === m.checkHash);
            return (
              <li
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5"
                data-testid={`dao-milestone-${m.index}`}
                key={m.index}
              >
                <span className="min-w-0 flex-1">
                  {m.index + 1}. {words ?? "Milestone"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {CHALLENGE_STAGE_LABEL[m.stage]}
                </span>
              </li>
            );
          })}
        </ol>
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
