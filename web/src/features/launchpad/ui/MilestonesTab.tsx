/**
 * The milestones: the part of the funding agreement a backer actually follows. Each one shows what the team agreed to
 * deliver, how many of its Shares that holds back, where the review stands, the evidence submitted, what each reviewer
 * said, when anyone can still object, and whether the Shares have been released. It reads the same for everyone, not
 * only the connected team wallet: the Work tab is where the team acts, this is where everyone else watches.
 *
 * It says plainly what the lock does and does not do. It holds back the team's original allocation; it does not stop
 * holders from voting to spend the treasury or to issue more Shares or non-voting shares.
 */

import { useNavigate } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  type ClaimFocus,
  claimFocusFor,
  workTabSearch,
} from "../lib/milestone-progress";
import {
  MILESTONE_STEPS,
  type ReviewerVerdict,
  type TimelineEntry,
} from "../lib/milestone-timeline";
import { formatShares } from "../lib/shares-format";
import type { Launch } from "../models";
import { useChallengeLockState } from "../use-challenge-lock";
import { useMilestoneTimeline } from "../use-milestone-timeline";
import { ChallengeMilestones } from "./ChallengeMilestones";
import { Linked } from "./EvidenceBlock";
import { countOf } from "@/shared/lib/count-of";

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

interface MilestonesTabProps {
  launch: Launch;
  /** The DAO this launch settled into, or null while the sale has not produced one. */
  dao: string | null;
  onOpenDecisions: () => void;
}

/**
 * The milestones, for whichever way the project's lock lets them through: holders who can object (read from the DAO's own
 * Shares, so it needs no record), or a named panel of reviewers.
 */
export function MilestonesTab(props: MilestonesTabProps) {
  const lock = useChallengeLockState(props.dao);
  if (props.dao !== null && lock.kind === "challenge" && lock.view) {
    return (
      <ChallengeMilestones
        dao={props.dao}
        launch={props.launch}
        lockState={lock}
        onOpenDecisions={props.onOpenDecisions}
        view={lock.view}
      />
    );
  }
  if (props.dao !== null && lock.kind === "loading") {
    return (
      <Card
        className="p-4 text-sm text-muted-foreground"
        data-testid="milestones-tab"
      >
        Reading the milestones from the network…
      </Card>
    );
  }
  // A read that failed says nothing about which rule this project uses, so no rule's guarantees are shown in its place.
  if (props.dao !== null && lock.kind === "unreadable") {
    return (
      <Card className="p-4" data-testid="milestones-rule-unreadable">
        <h2 className="text-base font-bold">Milestones</h2>
        <p
          className="mt-1 text-sm text-amber-800 dark:text-amber-200"
          role="status"
        >
          Could not read how this project&apos;s milestones are judged just now,
          so none of its milestones is shown as reached or not. That is not the
          same as there being nothing to see.
        </p>
        <Button
          className="mt-2"
          data-testid="milestones-rule-retry"
          onClick={lock.refresh}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </Card>
    );
  }
  return <PanelMilestones {...props} />;
}

function PanelMilestones({ launch, dao, onOpenDecisions }: MilestonesTabProps) {
  const { entries, summary, panel, reading, failed, labelOf } =
    useMilestoneTimeline(launch, dao);
  const navigate = useNavigate({ from: "/launchpad/$launchId" });
  // The claim goes in the address: the page opens the Work tab from it, and the Work tab focuses that claim.
  const openClaim = (claim: ClaimFocus) =>
    void navigate({
      search: (previous) => workTabSearch(previous, claim),
      replace: true,
    });
  const reviewerAddresses = (panel?.reviewers ?? []).map((r) => r.address);

  return (
    <div className="flex flex-col gap-4" data-testid="milestones-tab">
      <Card className="p-4">
        <h2 className="text-base font-bold">Milestones</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {panel
            ? "The team votes with all of its Shares from the start, but a defined part of them stays locked: it cannot be sold or moved until named reviewers read the evidence for a milestone and approve it, and a waiting period passes in which anyone can object."
            : "The team votes with all of its Shares from the start, but a defined part of them stays locked: it cannot be sold or moved until each milestone has been reached and judged. How they are judged is set when the project launches, and nobody can change it after."}
        </p>
        {dao && !reading && !failed ? (
          <p className="mt-2 text-sm" data-testid="milestones-summary">
            {summary.reached} of {countOf(summary.total, "milestone")} reached.{" "}
            {formatShares(summary.heldBack)} Shares still locked
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
            and if too few of them can be reached the locked Shares stay locked.
          </p>
        ) : null}
        {panel || launch.record.reviewerTerms ? (
          <p
            className="mt-2 whitespace-pre-wrap text-sm"
            data-testid="milestones-reviewer-terms"
          >
            {launch.record.reviewerTerms
              ? `In the team's own words, the reviewers will work like this: ${launch.record.reviewerTerms}`
              : "The team has not said how its reviewers will work."}
          </p>
        ) : null}
        <p
          className="mt-2 rounded-lg bg-black/5 p-2 text-xs text-muted-foreground dark:bg-white/5"
          data-testid="milestones-limits"
        >
          What this does not do: it holds back the team&apos;s original Shares.
          Holders can still vote to spend the treasury or to issue more Shares
          or non-voting shares, and those votes do not wait for milestones.{" "}
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
              onOpenClaim={dao ? openClaim : null}
              panelAddress={panel?.address ?? null}
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
  onOpenClaim,
  panelAddress,
}: {
  entry: TimelineEntry;
  labelOf: (address: string) => string;
  onOpenClaim: ((claim: ClaimFocus) => void) | null;
  panelAddress: string | null;
}) {
  const focus = claimFocusFor(entry.claimId, panelAddress);
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
              ? `About ${formatShares(entry.tokens)} Shares will be held back (${entry.percent}% of the milestone allocation)`
              : `${formatShares(entry.tokens)} Shares held back${entry.holders > 1 ? ` across ${entry.holders} team members` : ""}`
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
            Anyone can object until {day(entry.challengeEndsAt)}.
          </p>
        ) : null}
        {onOpenClaim && focus ? (
          <button
            className="mt-2 text-xs underline"
            data-testid={`milestone-open-claim-${entry.index}`}
            onClick={() => onOpenClaim(focus)}
            type="button"
          >
            Open the claim on the Work tab
          </button>
        ) : null}
      </Card>
    </li>
  );
}
