/**
 * What a DAO's overview page says first: what is waiting for you, and what is going on.
 *
 * A DAO's own page used to open on the raise it came from (price chart, "raise terms", what happens at the end), long
 * after the raise was over. The people who come back are there to run something, so the page opens on the questions an
 * operator asks in order: what is happening, does it need me, and what do I do about it.
 *
 * Everything here is read from what the page already has (the decisions and work the chain returned, and the connected
 * wallet); it adds no reads and no records of its own. Alias-free so `dao-overview.test.mjs` runs it under `node --test`.
 */

import {
  decodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import type {
  Decision,
  DecisionsSnapshot,
} from "@creaton/core/launchpad/decisions.ts";
import {
  canAcceptClaim,
  canExpire,
  claimStep,
  nextStep,
  type ClaimView,
} from "@creaton/core/launchpad/work.ts";
import type { WorkSnapshot } from "@creaton/core/launchpad/workRead.ts";
import { workTitle } from "./work-titles.ts";

/** The tab that holds the answer. */
type AttentionTab = "decisions" | "work" | "milestones";

export interface AttentionItem {
  /** Stable, so a list re-renders without flicker. */
  key: string;
  kind:
    | "bond"
    | "vote"
    | "move"
    | "bind"
    | "review"
    | "settle"
    | "expire"
    | "payout"
    | "award"
    | "waiting";
  /** One sentence, naming the thing. */
  text: string;
  /** The label of the one button. */
  action: string;
  tab: AttentionTab;
  /** Unix seconds when this changes by itself (a window closes, a vote ends), when there is such a moment. */
  due?: number;
  /** Why it is shown to this person, in a few words ("You hold Shares in this project."). */
  why?: string;
  /** What happens if they do nothing, in one sentence. */
  ifIgnored?: string;
  /** The claim it is about, so the button opens that claim on the Work tab rather than the tab's top. */
  claim?: { id: string; mandate: string };
  /**
   * Who acts: `you` (the default) for something only this person, or anyone including them, can do now; `others` for
   * this person's own work waiting on someone else (a manager, the reviewers, the challenge window, a vote).
   */
  actor?: "you" | "others";
}

const AWARD_SELECTOR = selectorOf(
  "awardContribution(address,bytes32,uint96,bool)",
).toLowerCase();

/**
 * The claims an open decision would award Shares for, as `budget:claim` in lower case: read from each decision's own
 * action (its opening transaction, verified against its id). Only a call to the DAO itself is an award: the same bytes
 * sent anywhere else award nothing. A decision whose action could not be read counts for nothing, so the founder is
 * still asked: a duplicate vote fails when it runs, a missing one loses the award.
 */
export function awardsUnderVote(
  decisions: DecisionsSnapshot | undefined,
): Set<string> {
  const out = new Set<string>();
  const dao = decisions?.dao.toLowerCase();
  for (const decision of decisions?.decisions ?? []) {
    if (!isOpenDecision(decision) || !decision.action) continue;
    if (decision.action.to.toLowerCase() !== dao) continue;
    const data = decision.action.data.toLowerCase();
    if (!data.startsWith(AWARD_SELECTOR)) continue;
    try {
      const [mandate, claim] = decodeParameters(
        ["address", "bytes32", "uint96", "bool"],
        `0x${data.slice(10)}`,
      ) as [string, string, bigint, boolean];
      out.add(`${mandate}:${claim}`.toLowerCase());
    } catch {
      // Not an award this app wrote: it counts for nothing.
    }
  }
  return out;
}

const OPEN_DECISION: readonly Decision["state"][] = [
  "Active",
  "Succeeded",
  "Queued",
];

/** A decision is still going on: collecting support, approved, or waiting to take effect. */
export function isOpenDecision(decision: Decision): boolean {
  return OPEN_DECISION.includes(decision.state);
}

/** Whether a queued decision's wait is over, so it can take effect now. */
function waitIsOver(decision: Decision, now: number): boolean {
  return (
    decision.state === "Queued" &&
    decision.queuedAt > 0 &&
    now >= decision.queuedAt + Number(decision.rules?.delay ?? 0n)
  );
}

const sameAddress = (a: string, b: string | null) =>
  b !== null && a.toLowerCase() === b.toLowerCase();

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Where a person's own claim stands while it waits on someone else, or null when it is theirs to act on or done. */
function waitingText(
  claim: ClaimView,
  step: ReturnType<typeof nextStep>,
  label: string,
  challengeWindow: number,
  now: number,
): { text: string; due?: number } | null {
  const money = claim.record.amount > 0n;
  switch (step.kind) {
    case "bind":
      return step.who === "manager"
        ? {
            text: `Your “${label}” is waiting for a work area's manager to accept it for review.`,
          }
        : null;
    case "review":
      return {
        text: `Your “${label}” is waiting for reviewers: ${claim.approvals} of ${claim.quorum} approvals${claim.objections > 0 ? `, ${claim.objections} turned it down` : ""}.`,
      };
    case "settle":
      // Approved: the contributor gets the step itself. Turned down: they are told, and pointed at why.
      // Who turned it down is always on the Work tab; a reason only when a reviewer published one.
      return step.verdict === "turned-down"
        ? {
            text: `The reviewers turned down your “${label}”. The Work tab shows who, and their reasons if they gave any.`,
          }
        : null;
    case "words":
      return {
        text: `Your “${label}” has words no open work area uses, so no manager can accept it. Submit it again under the same name and evidence, with a work area's words.`,
      };
    case "stuck":
      return {
        text: `Your “${label}” is stuck: the reviewers are split and nobody is left to decide. Once its deadline passes, anyone can close it.`,
        ...(step.lapsesAt > now ? { due: step.lapsesAt } : {}),
      };
    case "award":
      return {
        text: `Your “${label}” is finished. Shareholders decide by a vote whether to award Shares for it.`,
      };
    case "none": {
      if (claim.record.status !== "Approved") return null;
      const open = claim.record.releasedAt + challengeWindow;
      return open > now
        ? {
            text: `Your “${label}” was approved. You can ${money ? "take the payment" : "mark it finished"} once the challenge window ends.`,
            due: open,
          }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Who can accept this submission for review: the managers of the open work areas whose words it states. Lower-case,
 * each once; empty when no open area matches.
 */
export function managersFor(
  claim: ClaimView,
  mandate: Pick<
    WorkSnapshot["mandates"][number],
    "closed" | "expiresAt" | "projects"
  >,
  now: number,
): string[] {
  const found = new Set<string>();
  for (const project of mandate.projects) {
    const manager = project.record.manager;
    if (canAcceptClaim({ wallet: manager, mandate, project, claim, now }))
      found.add(manager.toLowerCase());
  }
  return [...found];
}

/** Whether a claim is not finished: still being reviewed, or approved and waiting to be taken. */
function isOpenClaim(claim: ClaimView): boolean {
  return claim.record.status === "Open" || claim.record.status === "Approved";
}

export interface OverviewInput {
  decisions: DecisionsSnapshot | undefined;
  work: WorkSnapshot | undefined;
  wallet: string | null;
  /** What a decision is called on screen; injected so this stays free of the describing code. */
  titleOf: (decision: Decision) => string;
  /** How a wallet is written (a person's name beside its short address); the short address alone when not given. */
  labelOf?: (address: string) => string;
}

/**
 * What is waiting for the connected wallet, most urgent first: a payout it can take, a claim it must review, a decision
 * it can back, a step anyone can take to move a decision along, and an award the DAO has yet to vote on. With no wallet
 * nothing is waiting for "you", and the list is empty.
 */
export function attentionItems(input: OverviewInput): AttentionItem[] {
  const { decisions, work, wallet, titleOf } = input;
  const who = input.labelOf ?? shortAddress;
  if (wallet === null) return [];
  const items: AttentionItem[] = [];

  for (const mandate of work?.mandates ?? []) {
    // A reviewer on a bonded panel cannot judge anything until their bond is posted: say so first, with the way to do it.
    if (
      mandate.walletIsReviewer &&
      !mandate.closed &&
      mandate.bond &&
      mandate.walletStake < mandate.bond.minBond
    ) {
      items.push({
        key: `bond-${mandate.address}`,
        kind: "bond",
        text: mandate.isMilestonePanel
          ? "You are one of the reviewers for the team's milestones. Post your bond before you judge one."
          : "You are a reviewer on a work budget. Post your bond before you judge a submission.",
        action: "Post your bond",
        tab: "work",
        why: "You are a named reviewer.",
        ifIgnored: "You cannot judge anything until your bond is posted.",
      });
    }
    for (const claim of mandate.claims) {
      // The milestone panel's claims are submitted by the team member who filed them, as the Work tab says too.
      const step = claimStep(claim, mandate, work?.chainTime ?? 0);
      if (
        step.kind === "payout" &&
        sameAddress(claim.record.contributor, wallet)
      ) {
        items.push({
          key: `payout-${claim.id}`,
          kind: "payout",
          claim: { id: claim.id, mandate: mandate.address },
          text:
            claim.record.amount > 0n
              ? "Your submission was approved. You can take your payment now."
              : "Your work was approved. Mark it finished so Shareholders can vote on an award.",
          action: claim.record.amount > 0n ? "Take it" : "Finish it",
          tab: "work",
          why: "It is your submission.",
          ifIgnored:
            claim.record.amount > 0n
              ? "The payment waits until you take it."
              : "It cannot be awarded Shares until it is marked finished.",
        });
      }
      if (
        step.kind === "review" &&
        mandate.walletIsReviewer &&
        !mandate.walletAttested.includes(claim.id)
      ) {
        items.push({
          key: `review-${claim.id}`,
          kind: "review",
          claim: { id: claim.id, mandate: mandate.address },
          text: `${who(claim.record.contributor)} submitted work that needs your review.`,
          action: "Review it",
          tab: "work",
          ...(claim.record.expiresAt > 0
            ? { due: claim.record.expiresAt }
            : {}),
          why: "You are a reviewer on this work budget.",
          ifIgnored:
            claim.record.expiresAt > 0 &&
            (work?.chainTime ?? 0) > claim.record.expiresAt
              ? "Anyone can now close this unanswered submission and return its stake and reserved payment."
              : "After its deadline, anyone can close an unanswered submission and return its stake and reserved payment.",
        });
      }
      const target = { id: claim.id, mandate: mandate.address };
      // One name for a piece of work everywhere it is mentioned: its readable title (D146).
      const label = workTitle(claim.id);
      const mine = sameAddress(claim.record.contributor, wallet);
      const managesItsArea =
        claim.project !== null &&
        mandate.projects.some(
          (p) =>
            p.id.toLowerCase() === claim.project?.toLowerCase() &&
            sameAddress(p.record.manager, wallet),
        );
      // A manager's turn: work submitted in their budget that one of their work areas can accept now (the same check the
      // budget makes: their area, open and not past its end, the same words, money left for a payment it asks for).
      const accepting =
        step.kind === "bind" && step.who === "manager"
          ? mandate.projects.filter((project) =>
              canAcceptClaim({
                wallet,
                mandate,
                project,
                claim,
                now: work?.chainTime ?? 0,
              }),
            )
          : [];
      if (accepting.length > 0) {
        items.push({
          key: `bind-${claim.id}`,
          kind: "bind",
          text:
            accepting.length === 1
              ? `${who(claim.record.contributor)} submitted “${workTitle(claim.id)}” for ${workTitle(accepting[0].id)}. Accept it so the reviewers can judge it.`
              : `${who(claim.record.contributor)} submitted “${workTitle(claim.id)}”. Accept it in one of your work areas so the reviewers can judge it.`,
          action: "Accept for review",
          tab: "work",
          claim: target,
          why: "You manage the work area its words are for.",
          ifIgnored:
            "The reviewers cannot judge it until a manager accepts it.",
        });
      }
      // A milestone claim of theirs, filed but not yet submitted to the milestone panel: their step, on Milestones.
      if (step.kind === "bind" && step.who === "contributor" && mine) {
        items.push({
          key: `bind-${claim.id}`,
          kind: "bind",
          text: `Your milestone claim “${label}” is filed but not yet submitted to the milestone panel.`,
          action: "Finish submitting",
          tab: "milestones",
          why: "You filed it; only you can submit it.",
          ifIgnored: "The panel cannot judge it until it is submitted.",
        });
      }
      // Enough turn-downs: anyone may close it, so it is offered to the work area's manager and the reviewers, who are
      // waiting on it; the contributor is told instead (below).
      if (
        step.kind === "settle" &&
        step.verdict === "turned-down" &&
        !mine &&
        (managesItsArea || mandate.walletIsReviewer)
      ) {
        items.push({
          key: `settle-${claim.id}`,
          kind: "settle",
          text: `Enough reviewers turned down “${label}” by ${who(claim.record.contributor)}. Anyone can now close it, you included.`,
          action: "Close it as turned down",
          tab: "work",
          claim: target,
          why: managesItsArea
            ? "You manage its work area."
            : "You are a reviewer on this work budget.",
          ifIgnored:
            "It stays open as waiting for reviewers until someone closes it.",
        });
      }
      // Past its deadline: anyone may close it as lapsed, which returns any deposit; offered to the contributor and the
      // manager.
      if (
        canExpire(claim.record, work?.chainTime ?? 0) &&
        step.kind !== "settle" &&
        (mine || managesItsArea)
      ) {
        items.push({
          key: `expire-${claim.id}`,
          kind: "expire",
          text: mine
            ? `Nobody finished the review of your “${label}” in time. Close it so it stops waiting${claim.record.stake > 0n ? " and your deposit comes back" : ""}.`
            : `Nobody finished the review of “${label}” by ${who(claim.record.contributor)} in time. Anyone can now close it as lapsed.`,
          action: "Close it as lapsed",
          tab: "work",
          claim: target,
          why: mine ? "It is your work." : "You manage its work area.",
          // `settle` has no deadline: until someone closes it, reviewers can still decide it.
          ifIgnored:
            step.kind === "review"
              ? "It stays open, and the reviewers can still decide it until someone closes it."
              : "It stays open until someone closes it.",
        });
      }
      // Enough approvals: anyone may finish the review, so it is offered to the two people who are waiting on it.
      if (
        step.kind === "settle" &&
        step.verdict === "approved" &&
        (mine || managesItsArea)
      ) {
        items.push({
          key: `settle-${claim.id}`,
          kind: "settle",
          text: mine
            ? `Enough reviewers approved your “${label}”. Anyone can now finish its review, you included.`
            : `Enough reviewers approved “${label}” by ${who(claim.record.contributor)}. Anyone can now finish its review, you included.`,
          action: "Finish the review",
          tab: "work",
          claim: target,
          why: mine ? "It is your work." : "You manage its work area.",
          ifIgnored:
            "Its challenge window starts only once the review is finished.",
        });
      }
      // The person's own work, waiting on someone else: said, so they know where it stands and who acts next. A milestone
      // claim's later steps (unlocking the milestone's Shares) are on the Milestones tab, so only its review is said.
      if (mine && (!mandate.isMilestonePanel || step.kind === "review")) {
        const waiting = waitingText(
          claim,
          step,
          label,
          mandate.challengeWindow,
          work?.chainTime ?? 0,
        );
        if (waiting) {
          items.push({
            key: `waiting-${claim.id}`,
            kind: "waiting",
            actor: "others",
            text: waiting.text,
            action: "See it",
            tab: "work",
            claim: target,
            ...(waiting.due !== undefined ? { due: waiting.due } : {}),
          });
        }
      }
    }
  }

  const capacity = decisions?.walletCapacity ?? 0n;
  const now = decisions?.chainTime ?? work?.chainTime ?? 0;
  for (const decision of decisions?.decisions ?? []) {
    if (decision.state === "Active" && capacity > 0n) {
      items.push({
        key: `vote-${decision.id}`,
        kind: "vote",
        text: `Open for your vote: ${titleOf(decision)}.`,
        action: "Vote",
        tab: "decisions",
        ...(decision.rules && decision.rules.expiresAt > 0n
          ? { due: Number(decision.rules.expiresAt) }
          : {}),
        why: "You hold Shares in this project.",
        ifIgnored:
          "If it does not gain enough support in time, it expires and nothing changes.",
      });
    } else if (decision.state === "Succeeded" || waitIsOver(decision, now)) {
      items.push({
        key: `move-${decision.id}`,
        kind: "move",
        text:
          decision.state === "Succeeded" && decision.queuedAt === 0
            ? `Approved and ready to start its wait: ${titleOf(decision)}.`
            : `Ready to take effect: ${titleOf(decision)}.`,
        action: "Open it",
        tab: "decisions",
        why: "Anyone can move an approved decision along.",
        ifIgnored: "Nothing changes until someone does.",
      });
    }
  }

  if (capacity > 0n) {
    // A vote that would award a claim is already under way: asking for another would only make a duplicate that fails.
    const voting = awardsUnderVote(decisions);
    for (const mandate of work?.mandates ?? []) {
      for (const claim of mandate.claims) {
        if (
          nextStep(claim, work?.chainTime ?? 0, mandate.challengeWindow)
            .kind === "award" &&
          !voting.has(`${mandate.address}:${claim.id}`.toLowerCase())
        ) {
          items.push({
            key: `award-${claim.id}`,
            kind: "award",
            text: `The work of ${who(claim.record.contributor)} is done. The DAO can vote to award Shares for it.`,
            action: "Put it to a vote",
            tab: "decisions",
            why: "You hold Shares in this project.",
            ifIgnored:
              "The contributor is not awarded Shares until a vote passes.",
          });
        }
      }
    }
  }
  return rankAttention(items, now);
}

const KIND_ORDER: readonly AttentionItem["kind"][] = [
  "bond",
  "payout",
  "review",
  "bind",
  "settle",
  "expire",
  "vote",
  "move",
  "award",
  "waiting",
];

/**
 * Most urgent first. Whatever has a moment after which it changes by itself (a window closes, a vote ends) comes first,
 * soonest first, because that is where waiting costs something; then the rest, by what they ask of the person (a bond to
 * post or a payout to take before a vote, a step anyone can take last). Equal items keep the order they came in.
 *
 * Each entry carries the clock of the chain it was read from: a deadline is in that chain's time, so entries from
 * different projects (or a local test chain far ahead of the wall clock) are each judged against their own.
 */
export function rankEntries<T extends { item: AttentionItem; now: number }>(
  entries: readonly T[],
): T[] {
  const timed = ({ item, now }: T) => item.due !== undefined && item.due > now;
  return entries
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => {
      const aTimed = timed(a.entry);
      const bTimed = timed(b.entry);
      if (aTimed !== bTimed) return aTimed ? -1 : 1;
      if (aTimed && bTimed) {
        const byDue = (a.entry.item.due ?? 0) - (b.entry.item.due ?? 0);
        if (byDue !== 0) return byDue;
      }
      const byKind =
        KIND_ORDER.indexOf(a.entry.item.kind) -
        KIND_ORDER.indexOf(b.entry.item.kind);
      return byKind !== 0 ? byKind : a.at - b.at;
    })
    .map(({ entry }) => entry);
}

/** {@link rankEntries} for the items of one project, all read at the same time `now`. */
export function rankAttention<T extends AttentionItem>(
  items: readonly T[],
  now: number,
): T[] {
  return rankEntries(items.map((item) => ({ item, now }))).map(
    ({ item }) => item,
  );
}

export interface OverviewCounts {
  openDecisions: number;
  openClaims: number;
  /** Open work a manager accepted, so the reviewers are judging it now (not work still waiting for a manager). */
  inReview?: number;
  workBudgets: number;
  /** Decisions that ran: the DAO has done things, even if nothing is open right now. */
  carriedOut?: number;
}

export function overviewCounts(
  decisions: DecisionsSnapshot | undefined,
  work: WorkSnapshot | undefined,
): OverviewCounts {
  const mandates = work?.mandates ?? [];
  return {
    openDecisions: (decisions?.decisions ?? []).filter(isOpenDecision).length,
    openClaims: mandates.reduce(
      (sum, mandate) => sum + mandate.claims.filter(isOpenClaim).length,
      0,
    ),
    inReview: mandates.reduce(
      (sum, mandate) =>
        sum +
        mandate.claims.filter(
          (claim) => claim.record.status === "Open" && claim.project !== null,
        ).length,
      0,
    ),
    // The milestone panel judges the team's milestones and holds no budget: it is not "a work budget" to start with.
    workBudgets: mandates.filter(
      (mandate) => !mandate.closed && !mandate.isMilestonePanel,
    ).length,
    carriedOut: (decisions?.decisions ?? []).filter(
      (decision) => decision.state === "Executed",
    ).length,
  };
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The one line under the title: what is going on, in words, or that nothing is. */
export function summaryLine(counts: OverviewCounts): string {
  const parts: string[] = [];
  if (counts.openDecisions > 0) {
    parts.push(
      `${plural(counts.openDecisions, "decision is", "decisions are")} open`,
    );
  }
  if (counts.openClaims > 0) {
    parts.push(
      `${plural(counts.openClaims, "piece of work is", "pieces of work are")} in progress`,
    );
  }
  if (parts.length === 0) {
    if (counts.workBudgets > 0) {
      return "Nothing is waiting. Work budgets are open for people to submit work.";
    }
    // A DAO that has already done things is not "just starting": say that no work budget is open.
    return (counts.carriedOut ?? 0) > 0
      ? "Nothing is waiting, and no work budget is open. Put a decision to a vote to set work in motion."
      : "Nothing is going on yet. Put the first decision to a vote to set work in motion.";
  }
  return `${parts.join(" and ")}.`.replace(/^./, (c) => c.toUpperCase());
}
