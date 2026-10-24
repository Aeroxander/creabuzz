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
 *
 * Once the DAO exists, what it guarantees is read from it, not assumed: leaving is promised as permanent only by a DAO
 * made after that became so (D73) with leaving on, and the notice before a decision runs is today's setting, which a
 * vote can shorten for later decisions (`lib/dao-guarantees.ts`).
 */

import type { ReactNode } from "react";

import { Card } from "@/shared/ui/card";

import { recordSaleCurrency } from "../chain";
import { formatAtomic } from "../lib/amounts";
import { span } from "../lib/challenge-copy";
import {
  type DaoGuarantees,
  DEFAULT_NOTICE,
  noticeText,
} from "../lib/dao-guarantees";
import { NO_CAP, type ShareRules } from "../lib/trading-actions";
import { isEvmAddress, type LaunchRecord } from "../models";
import { useDecisionContext } from "../use-decisions";
import { useDaoGuarantees } from "../use-dao-guarantees";
import { useShareRules } from "../use-share-rules";
import { lockKindOf, useChallengeLock } from "../use-challenge-lock";
import { useWork } from "../use-work";
import { planVoteControlText, VoteControlNote } from "./VoteControlNote";

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

/** How a lock that lets holders object lets milestones through, as a backer needs it before they bid. */
export interface ChallengeFacts {
  window: number;
  votePeriod: number;
  clawback: number;
  minRejectBps: number;
  /** The bond the team posts with each milestone, in words, or null for none. */
  bond: string | null;
}

const GOVERNANCE_WAITS =
  "No decision of any kind can be opened before the buyers can claim their tokens.";
const LEAVING_PERMANENT =
  "No vote can switch off leaving with your share of what the DAO holds, or take your Shares from you.";
const LEAVING_OFF =
  "This DAO was made with leaving switched off, and no vote can switch it on: members cannot take a share of the treasury out.";
const LEAVING_SWITCHABLE =
  "Switch leaving off, or burn a holder's Shares: this DAO was made before those powers were removed.";

/**
 * What the DAO says about leaving: `plan` before it exists (the launch makes leaving permanent), its answers once read,
 * or `unknown` while they are being read or could not be.
 */
type Leaving = "plan" | "unknown" | DaoGuarantees;

function leavingLines(leaving: Leaving): string[] {
  if (leaving === "plan") return [LEAVING_PERMANENT];
  if (leaving === "unknown" || !leaving.leavingPermanent) return [];
  return [leaving.ragequittable ? LEAVING_PERMANENT : LEAVING_OFF];
}

/** What the DAO's Shares say about new Shares and trading (D76, D77), when they could be read. */
function ruleLines(rules: ShareRules | null): string[] {
  if (!rules) return [];
  const lines: string[] = [];
  if (rules.awardsOnly) {
    lines.push(
      rules.issuanceCapBps === NO_CAP
        ? "New Shares are only ever given for work the reviewers accepted. No vote can create Shares any other way."
        : `New Shares are only ever given for work the reviewers accepted, and at most ${rules.issuanceCapBps / 100}% more a year of the Shares that count when someone leaves. No vote can raise that limit.`,
    );
  }
  if (rules.transfersLocked && rules.unlockNoticeRequired) {
    lines.push(
      "Shares cannot be sent between wallets, so nobody can sell them, until a vote opens trading; that vote can only run 30 days after trading is announced, and you can leave in between.",
    );
  }
  return lines;
}

const LOCKED = [
  "The team's locked Shares unlock only when the named reviewers approve each milestone. The lock is set once, at launch.",
  "Until then they cannot be sold, moved, or taken out by leaving the DAO.",
  "Who judges the milestones is named at launch, with how many must agree. A vote cannot swap in a different panel.",
] as const;

/** Said when the project's rule for judging milestones is not known (no DAO yet, or it could not be read): true of every rule. */
const LOCKED_RULE_UNKNOWN = [
  "The team's locked Shares unlock only when a milestone is reached and judged under the rule the project sets when it launches. The lock is set once, at launch.",
  "Until then they cannot be sold, moved, or taken out by leaving the DAO.",
  "How milestones are judged is fixed at launch: no vote can change it, and no vote can free the locked Shares.",
] as const;

const LOCKED_BY_OBJECTION = (c: ChallengeFacts) =>
  [
    `The team's locked Shares unlock only when a milestone is reached: the team publishes its evidence, holders have ${span(c.window)} to object, and a vote of holders can turn it down. The lock is set once, at launch.`,
    "Until then they cannot be sold, moved, or taken out by leaving the DAO.",
    "How milestones are judged is set at launch. No vote can change it.",
  ] as const;

const NOT_LOCKED = [
  "The team's Shares are not locked. The team can sell or move them from the start, and they count when the DAO votes.",
] as const;

function votable(rules: ShareRules | null, leaving: Leaving): string[] {
  return [
    ...(typeof leaving === "object" && !leaving.leavingPermanent
      ? [LEAVING_SWITCHABLE]
      : []),
    "Spend the money the DAO holds.",
    rules?.awardsOnly
      ? "Award new Shares for accepted work, within that limit."
      : "Issue new Shares.",
    ...(rules?.transfersLocked
      ? [
          "Announce that trading opens. A second vote can open it 30 days later.",
        ]
      : rules
        ? ["Lock trading again."]
        : []),
    "Change the voting rules themselves: how many must vote, how many must agree, and how long a decision waits.",
  ];
}

const GIVE_UP =
  "Give up a team member's unearned Shares. They are burned, never released for sale.";

export function PowersCard({
  locked,
  panel,
  reviewerTerms = null,
  challenge = null,
  rule = "panel",
  ruleUnreadable = false,
  shareRules = null,
  guarantees = "plan",
  voteControl = null,
}: {
  /** The plan locks the team's Shares behind milestones. */
  locked: boolean;
  /** The milestone panel as read from the chain, once the project is launched. */
  panel: PanelFacts | null;
  /** How the team says its reviewers will work, in its own words; null when it never said. */
  reviewerTerms?: string | null;
  /** Set when the milestones unlock unless holders object, instead of a panel approving them. */
  challenge?: ChallengeFacts | null;
  /**
   * How milestones are judged, as far as it is known: holders' objections, a panel of named reviewers, or not known (the
   * project has no DAO yet, or its lock could not be read). Nothing is said of reviewers unless it is known to be a panel.
   */
  rule?: "challenge" | "panel" | "unknown";
  /** The rule is unknown because reading it failed, which the card says. */
  ruleUnreadable?: boolean;
  /** What the DAO's Shares say about new Shares and trading, or null when not known (no DAO yet, or older Shares). */
  shareRules?: ShareRules | null;
  /**
   * What the DAO guarantees an outvoted holder, as read from it; `plan` before the DAO exists, `unknown` while it is
   * being read or when it could not be.
   */
  guarantees?: Leaving;
  /** Who decides right now: read from the DAO once it exists, or the plan's split before. */
  voteControl?: ReactNode;
}) {
  const canLeave =
    guarantees === "plan" ||
    (typeof guarantees === "object" && guarantees.ragequittable);
  const permanent =
    guarantees === "plan" ||
    (typeof guarantees === "object" && guarantees.leavingPermanent);
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
        {[
          ...(locked
            ? challenge
              ? LOCKED_BY_OBJECTION(challenge)
              : rule === "unknown"
                ? LOCKED_RULE_UNKNOWN
                : LOCKED
            : NOT_LOCKED),
          GOVERNANCE_WAITS,
          ...leavingLines(guarantees),
          ...ruleLines(shareRules),
        ].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {locked && challenge ? (
        <div className="mt-2 text-sm" data-testid="launch-powers-challenge">
          <p>
            Each milestone waits {span(challenge.window)} for objections, longer
            for a bigger one and longer again after each attempt holders turn
            down. A holder who objects starts a vote that runs for{" "}
            {span(challenge.votePeriod)}; the team&apos;s own Shares do not
            count. The objection stands only if more is against the milestone
            than for it and at least {challenge.minRejectBps / 100}% of what
            could vote is against it. With less interest than that, including
            when nobody votes, the milestone stands.
            {challenge.bond
              ? ` The team posts a bond of ${challenge.bond} with each milestone; it is forfeited if holders turn the milestone down.`
              : ""}
          </p>
          <p className="mt-1">
            For {span(challenge.clawback)} after an unlock one more objection is
            possible, and if holders uphold it the team&apos;s remaining locked
            Shares are burned. Milestones are published in order, and the next
            only once the one before has had its time for late objections, so
            the Shares still ahead stay locked while an earlier milestone can be
            objected to; what stands behind the last milestone is the bond.
          </p>
          <p className="mt-1 text-black/60 dark:text-white/60">
            This protects you only as far as someone is watching: a milestone
            nobody objects to unlocks. You can leave with your share of the
            treasury while one waits.
          </p>
        </div>
      ) : locked && rule === "unknown" ? (
        <div className="mt-2 text-sm" data-testid="launch-powers-rule">
          {ruleUnreadable ? (
            <p>
              How this project&apos;s milestones are judged could not be read
              just now. It is shown on the Milestones tab once it can be.
            </p>
          ) : (
            <p className="text-black/60 dark:text-white/60">
              Whether holders can object or named reviewers approve is chosen
              when the project launches, and is shown here and on the Milestones
              tab from then on.
            </p>
          )}
        </div>
      ) : locked ? (
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
        {[...votable(shareRules, guarantees), ...(locked ? [GIVE_UP] : [])].map(
          (line) => (
            <li key={line}>{line}</li>
          ),
        )}
      </ul>
      {voteControl ? (
        <>
          <h3 className="mt-3 text-sm font-medium">Who decides right now</h3>
          {voteControl}
        </>
      ) : null}
      <h3 className="mt-3 text-sm font-medium">
        If a decision goes against you
      </h3>
      <p className="mt-1 text-sm" data-testid="launch-powers-notice">
        {guarantees === "plan"
          ? noticeText(DEFAULT_NOTICE, "plan")
          : guarantees === "unknown"
            ? "Every decision waits before it runs. How long, under this DAO's settings today, could not be read just now; a vote can shorten those settings for decisions opened later."
            : noticeText(guarantees.notice, "dao")}{" "}
        {guarantees === "unknown"
          ? "Whether you can leave with your share before a decision runs is shown once this DAO's rules can be read."
          : canLeave
            ? `Until it runs, you can leave with your share of what the DAO holds${permanent ? "; no vote can switch that off" : ", for as long as leaving stays on"}. Money already moved into a work budget is not part of that share.`
            : "Members cannot leave this DAO with a share of what it holds."}
      </p>
    </Card>
  );
}

/** The card for a launch record: it reads the milestone panel from the chain once the project has a DAO. */
export function PowersSection({ record }: { record: LaunchRecord }) {
  const locked = record.unlocks?.mode === "milestones";
  const treasury =
    record.treasury && isEvmAddress(record.treasury) ? record.treasury : null;
  const context = useDecisionContext(treasury);
  const rules = useShareRules(context.data?.shares ?? null, treasury);
  const guarantees = useDaoGuarantees(treasury, context.data?.policy ?? null);
  const planText = planVoteControlText(record.allocation);
  const dao =
    locked && record.treasury && isEvmAddress(record.treasury)
      ? record.treasury
      : null;
  const work = useWork(dao, null);
  const challengeLock = useChallengeLock(dao);
  const kind = lockKindOf(dao, challengeLock);
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
  const lock = kind === "challenge" ? (challengeLock.data ?? null) : null;
  const sale = recordSaleCurrency(record);
  const challenge: ChallengeFacts | null = lock
    ? {
        window: lock.terms.window,
        votePeriod: lock.terms.votePeriod,
        clawback: lock.terms.clawback,
        minRejectBps: lock.terms.minRejectBps,
        bond:
          lock.terms.bond > 0n &&
          (lock.terms.bondToken ?? "").toLowerCase() ===
            sale.value.toLowerCase()
            ? `${formatAtomic(lock.terms.bond, sale.decimals, { maxFractionDigits: 2 })} ${sale.symbol}`
            : null,
      }
    : null;
  return (
    <PowersCard
      challenge={challenge}
      locked={locked}
      panel={kind === "panel" ? panel : null}
      reviewerTerms={kind === "panel" ? record.reviewerTerms : null}
      rule={
        kind === "challenge"
          ? "challenge"
          : kind === "panel"
            ? "panel"
            : "unknown"
      }
      ruleUnreadable={kind === "unreadable"}
      shareRules={rules.data?.rules ?? null}
      guarantees={treasury === null ? "plan" : (guarantees.data ?? "unknown")}
      voteControl={
        treasury !== null ? (
          <VoteControlNote dao={treasury} kind="raise" />
        ) : planText ? (
          <p className="mt-2 text-sm" data-testid="vote-control-plan">
            {planText}
          </p>
        ) : null
      }
    />
  );
}
