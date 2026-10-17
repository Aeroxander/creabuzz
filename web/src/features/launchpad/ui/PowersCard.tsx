/**
 * What the holders and the team can and cannot change, on the launch page of a project that has its own DAO.
 *
 * A lock on the team's Shares is not a promise that nobody can ever do anything else with the project's money. The page
 * says both halves in plain words, before a backer bids: what no vote can undo, what the holders can still decide (the
 * team votes too, from the first day), and what protects someone who is outvoted. Each line is true of the contracts the
 * launch creates; the starting rules are the DAO's to change by vote, and the card says so.
 *
 * It follows the plan: a launch that does not lock the team's Shares says so and drops the lines about the lock, and a
 * launch with a lock tells backers who judges the milestones, how many must agree, until when, and what happens if they
 * cannot be reached.
 */

import { Card } from "@/shared/ui/card";

import { formatAtomic } from "../lib/amounts";
import { isEvmAddress, type LaunchRecord } from "../models";
import { useWork } from "../use-work";

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** The milestone panel as a backer needs it: who decides, how many must agree, until when, and the bond they post. */
export interface PanelFacts {
  reviewers: number;
  quorum: number;
  expiresAt: number;
  closed: boolean;
  bond: string | null;
}

const ALWAYS = [
  "No decision of any kind can be opened before the buyers can claim their tokens.",
] as const;

const LOCKED = [
  "The team's locked Shares unlock only when the named reviewers approve each milestone. The lock is set once, at launch.",
  "Until then they cannot be sold, moved, or taken out by leaving the DAO.",
  "Who judges the milestones is named at launch, with how many must agree. A vote cannot swap in a different panel.",
] as const;

const NOT_LOCKED = [
  "The team's Shares are not locked. The team can sell or move them from the start, and they count when the DAO votes.",
] as const;

const VOTABLE = [
  "Spend the money the DAO holds.",
  "Issue new Shares.",
  "Turn leaving with your share of the treasury on or off.",
  "Change the voting rules themselves: how many must vote, how many must agree, and how long a decision waits.",
] as const;

const GIVE_UP =
  "Give up a team member's unearned Shares. They are burned, never released for sale.";

export function PowersCard({
  locked,
  panel,
  reviewerTerms = null,
}: {
  /** The plan locks the team's Shares behind milestones. */
  locked: boolean;
  /** The milestone panel as read from the chain, once the project is launched. */
  panel: PanelFacts | null;
  /** How the team says its reviewers will work, in its own words; null when it never said. */
  reviewerTerms?: string | null;
}) {
  return (
    <Card className="p-4" data-testid="launch-powers">
      <h2 className="text-base font-semibold">
        What can and cannot be changed
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {locked
          ? "The lock on the team's Shares is a real commitment, but it is not the only thing that decides what happens to the money. Read both halves before you bid."
          : "This project does not lock the team's Shares. Read what a vote can still decide before you bid."}
      </p>
      <h3 className="mt-3 text-sm font-medium">No vote can undo</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {[...(locked ? LOCKED : NOT_LOCKED), ...ALWAYS].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {locked ? (
        <div className="mt-2 text-sm" data-testid="launch-powers-panel">
          {panel ? (
            <p>
              The milestone panel has {panel.reviewers} reviewer
              {panel.reviewers === 1 ? "" : "s"}, and {panel.quorum} must agree
              on each milestone.{" "}
              {panel.closed
                ? "It is closed."
                : `It stays open until ${day(panel.expiresAt)}.`}
              {panel.bond ? ` Each posts a bond of ${panel.bond}.` : ""}
            </p>
          ) : null}
          <p
            className="mt-1 whitespace-pre-wrap"
            data-testid="launch-powers-terms"
          >
            {reviewerTerms
              ? `In the team's own words, the reviewers will work like this: ${reviewerTerms}`
              : "The team has not said how its reviewers will work."}
          </p>
          <p className="mt-1 text-black/60 dark:text-white/60">
            That is the team&apos;s statement; the network cannot check it. The
            reviewers are fixed. If too few of them can be reached, or the panel
            runs out, no milestone can be approved and the locked Shares stay
            locked; the only thing the DAO can then do with them is give them up
            and burn them.
          </p>
        </div>
      ) : null}
      <h3 className="mt-3 text-sm font-medium">
        The holders can change by vote
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        The team votes too
        {locked ? ", with its locked Shares," : ""} from the first day.
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {[...VOTABLE, ...(locked ? [GIVE_UP] : [])].map((line) => (
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

/** The card for a launch record: it reads the milestone panel from the chain once the project has a DAO. */
export function PowersSection({ record }: { record: LaunchRecord }) {
  const locked = record.unlocks?.mode === "milestones";
  const dao =
    locked && record.treasury && isEvmAddress(record.treasury)
      ? record.treasury
      : null;
  const work = useWork(dao, null);
  const mandate = work.data?.mandates.find((m) => m.isMilestonePanel);
  const panel: PanelFacts | null = mandate
    ? {
        reviewers: mandate.reviewers.length || mandate.quorum,
        quorum: mandate.quorum,
        expiresAt: mandate.expiresAt,
        closed: mandate.closed,
        bond: mandate.bond
          ? mandate.bond.decimalsKnown
            ? `${formatAtomic(mandate.bond.minBond, mandate.bond.decimals, { maxFractionDigits: 2 })} ${mandate.bond.symbol}`
            : `${mandate.bond.minBond.toString()} raw units of ${mandate.bond.symbol}`
          : null,
      }
    : null;
  return (
    <PowersCard
      locked={locked}
      panel={panel}
      reviewerTerms={record.reviewerTerms}
    />
  );
}
