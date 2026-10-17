/**
 * The milestones: the part of the funding agreement a backer actually follows. Each one shows what the team agreed to
 * deliver, how many of its tokens that holds back, where the review stands, the evidence submitted, what each reviewer
 * said, when anyone can still object, and whether the tokens have been released. It reads the same for everyone, not
 * only the connected team wallet: the Work tab is where the team acts, this is where everyone else watches.
 *
 * It says plainly what the lock does and does not do. It holds back the team's original allocation; it does not stop
 * holders from voting to spend the treasury or to issue more Shares.
 */

import { Card } from "@/shared/ui/card";

import {
  buildTimeline,
  MILESTONE_STEPS,
  type ReviewerVerdict,
  type TimelineEntry,
} from "../lib/milestone-timeline";
import { plannedMilestoneTokens } from "../lib/milestone-plan";
import { formatShares } from "../lib/shares-format";
import type { Launch } from "../models";
import { useEvidencePackets } from "../use-evidence";
import { useRecordEvents, useWork } from "../use-work";
import { useWalletLabels } from "../use-wallet-labels";
import { Linked } from "./EvidenceBlock";

const STAGE_LABEL: Record<TimelineEntry["stage"], string> = {
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

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const VERDICT_WORDS: Record<ReviewerVerdict["verdict"], string> = {
  approved: "approved",
  objected: "objected",
  none: "has not decided",
  unknown: "could not be read",
};

export function MilestonesTab({
  launch,
  dao,
  onOpenWork,
  onOpenDecisions,
}: {
  launch: Launch;
  /** The DAO this launch settled into, or null while the sale has not produced one. */
  dao: string | null;
  onOpenWork: () => void;
  onOpenDecisions: () => void;
}) {
  const plan = launch.record.unlocks;
  const plannedTokens = plannedMilestoneTokens(launch.record);
  const planned = (plan?.milestones ?? []).map((m, index) => ({
    label: m.label,
    percent: m.percent,
    plannedTokens: plannedTokens[index] ?? null,
  }));
  const work = useWork(dao, null);
  const events = useRecordEvents(dao, work.data);
  const evidence = useEvidencePackets(launch);
  const panel = work.data?.mandates.find((m) => m.isMilestonePanel) ?? null;
  const reviewerAddresses = (panel?.reviewers ?? []).map((r) => r.address);
  const labelOf = useWalletLabels(reviewerAddresses);

  // A project with a DAO whose chain read has not come back is not shown as "agreed": that would claim nothing has
  // happened. It says it is reading, or that it could not.
  const reading = dao !== null && (work.isLoading || events.isLoading);
  const failed = dao !== null && !reading && (!work.data || !events.data);
  const { entries, summary } = buildTimeline({
    milestones: planned,
    panel: panel
      ? {
          address: panel.address,
          reviewers: panel.reviewers,
          quorum: panel.quorum,
          challengeWindow: panel.challengeWindow,
          claims: panel.claims,
        }
      : null,
    tranches: (events.data?.promises ?? []).map((p) => p.tranches),
    verdicts: events.data?.verdicts,
    packets: evidence.packets,
    now: work.data?.chainTime ?? Math.floor(Date.now() / 1000),
  });

  return (
    <div className="flex flex-col gap-4" data-testid="milestones-tab">
      <Card className="p-4">
        <h2 className="text-base font-bold">Milestones</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The team votes with all of its tokens from the start, but a defined
          part of them stays locked: it cannot be sold or moved until named
          reviewers read the evidence for a milestone and approve it, and a
          waiting period passes in which anyone can object.
        </p>
        {dao && !reading && !failed ? (
          <p className="mt-2 text-sm" data-testid="milestones-summary">
            {summary.reached} of {summary.total} milestones reached.{" "}
            {formatShares(summary.heldBack)} tokens still locked
            {summary.released > 0n
              ? `, ${formatShares(summary.released)} released`
              : ""}
            {summary.givenUp > 0n
              ? `, ${formatShares(summary.givenUp)} given up by the DAO`
              : ""}
            .
          </p>
        ) : null}
        {panel ? (
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="milestones-panel"
          >
            Reviewers:{" "}
            {reviewerAddresses.length > 0
              ? reviewerAddresses.map(labelOf).join(", ")
              : "named at launch"}
            . {panel.quorum} must agree on a milestone. The panel is fixed when
            the project launches: nobody can swap in friendlier reviewers later,
            and if too few of them can be reached the locked tokens stay locked.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            The reviewers are named when the project launches, and cannot be
            changed after.
          </p>
        )}
        <p
          className="mt-2 whitespace-pre-wrap text-sm"
          data-testid="milestones-reviewer-terms"
        >
          {launch.record.reviewerTerms
            ? `In the team's own words, the reviewers will work like this: ${launch.record.reviewerTerms}`
            : "The team has not said how its reviewers will work."}
        </p>
        <p
          className="mt-2 rounded-lg bg-black/5 p-2 text-xs text-muted-foreground dark:bg-white/5"
          data-testid="milestones-limits"
        >
          What this does not do: it holds back the team&apos;s original tokens.
          Holders can still vote to spend the treasury or to issue more tokens,
          and those votes do not wait for milestones.{" "}
          <button className="underline" onClick={onOpenDecisions} type="button">
            See the decisions
          </button>
        </p>
      </Card>

      {reading ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Reading the milestones from the network…
        </Card>
      ) : failed ? (
        <Card
          className="p-4 text-sm text-amber-800 dark:text-amber-200"
          data-testid="milestones-failed"
        >
          Could not read where the milestones stand just now, so none is shown
          as reached or not. Try again in a moment.
        </Card>
      ) : entries.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">
          This project has no milestones: nothing of the team&apos;s is locked
          behind delivery.
        </Card>
      ) : (
        <ol className="flex flex-col gap-3">
          {entries.map((entry) => (
            <MilestoneCard
              entry={entry}
              key={entry.index}
              labelOf={labelOf}
              onOpenWork={dao ? onOpenWork : null}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function MilestoneCard({
  entry,
  labelOf,
  onOpenWork,
}: {
  entry: TimelineEntry;
  labelOf: (address: string) => string;
  onOpenWork: (() => void) | null;
}) {
  return (
    <li data-testid={`milestone-${entry.index}`}>
      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Milestone {entry.index + 1}: {entry.label}
          </h3>
          <span
            className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium"
            data-testid={`milestone-stage-${entry.index}`}
          >
            {STAGE_LABEL[entry.stage]}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {entry.tokens !== null
            ? entry.tokensPlanned
              ? `About ${formatShares(entry.tokens)} tokens will be held back (${entry.percent}% of the milestone allocation)`
              : `${formatShares(entry.tokens)} tokens held back${entry.holders > 1 ? ` across ${entry.holders} team members` : ""}`
            : entry.percent !== null
              ? `${entry.percent}% of the milestone allocation`
              : ""}
        </p>
        {entry.stage !== "agreed" && entry.stage !== "given-up" ? (
          <ol
            aria-label="Progress"
            className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"
          >
            {MILESTONE_STEPS.map((step, index) => (
              <li
                className={
                  index < entry.done
                    ? "text-emerald-700 dark:text-emerald-300"
                    : index === entry.done
                      ? "font-medium"
                      : "text-muted-foreground"
                }
                key={step}
              >
                {index < entry.done ? "✓ " : `${index + 1}. `}
                {step}
              </li>
            ))}
          </ol>
        ) : null}
        <p
          className="mt-2 text-sm"
          data-testid={`milestone-headline-${entry.index}`}
        >
          {entry.headline}
        </p>
        {entry.earlierAttempts > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {entry.earlierAttempts === 1
              ? "One earlier submission was turned down or closed."
              : `${entry.earlierAttempts} earlier submissions were turned down or closed.`}
          </p>
        ) : null}

        {entry.verdicts.length > 0 && entry.claimId ? (
          <ul
            className="mt-2 flex flex-wrap gap-1.5 text-xs"
            data-testid={`milestone-verdicts-${entry.index}`}
          >
            {entry.verdicts.map((v) => (
              <li
                className="rounded-full border border-border/60 px-2 py-0.5"
                key={v.reviewer}
              >
                {labelOf(v.reviewer)} {VERDICT_WORDS[v.verdict]}
              </li>
            ))}
          </ul>
        ) : null}

        {entry.evidence ? (
          <details className="mt-2 rounded-md bg-black/5 p-2 text-sm dark:bg-white/5">
            <summary
              className="cursor-pointer text-xs font-medium"
              data-testid={`milestone-evidence-toggle-${entry.index}`}
            >
              Evidence the team submitted
            </summary>
            <p
              className="mt-1 whitespace-pre-wrap"
              data-testid={`milestone-evidence-${entry.index}`}
            >
              <Linked text={entry.evidence.text} />
            </p>
            {entry.evidence.check ? (
              <>
                <p className="mt-2 text-xs font-medium text-muted-foreground">
                  It is judged against
                </p>
                <p className="mt-1 whitespace-pre-wrap">
                  {entry.evidence.check}
                </p>
              </>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              This is the text the claim committed to on the network: it
              matches.
            </p>
          </details>
        ) : entry.evidenceMissing ? (
          <p
            className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid={`milestone-evidence-missing-${entry.index}`}
          >
            No evidence matching this claim could be found. Reviewers cannot
            approve what they cannot read.
          </p>
        ) : null}

        {entry.challengeEndsAt ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Challenge window ends {day(entry.challengeEndsAt)}.
          </p>
        ) : null}
        {onOpenWork && entry.claimId ? (
          <button
            className="mt-2 text-xs underline"
            onClick={onOpenWork}
            type="button"
          >
            Open the claim on the Work tab
          </button>
        ) : null}
      </Card>
    </li>
  );
}
