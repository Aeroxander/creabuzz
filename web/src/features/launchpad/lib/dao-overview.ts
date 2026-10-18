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

import type { Decision, DecisionsSnapshot } from "./decisions.ts";
import { nextStep, type ClaimView } from "./work.ts";
import type { WorkSnapshot } from "./work-read.ts";

/** The tab that holds the answer. */
export type AttentionTab = "decisions" | "work" | "milestones";

export interface AttentionItem {
  /** Stable, so a list re-renders without flicker. */
  key: string;
  kind: "bond" | "vote" | "move" | "review" | "payout" | "award";
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
}

const OPEN_DECISION: readonly Decision["state"][] = [
  "Active",
  "Succeeded",
  "Queued",
];

/** A decision is still going on: collecting support, approved, or waiting to run. */
export function isOpenDecision(decision: Decision): boolean {
  return OPEN_DECISION.includes(decision.state);
}

/** Whether a queued decision's wait is over, so it can run now. */
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
          : "You are a reviewer on a work budget. Post your bond before you judge a claim.",
        action: "Post your bond",
        tab: "work",
        why: "You are a named reviewer.",
        ifIgnored: "You cannot judge anything until your bond is posted.",
      });
    }
    for (const claim of mandate.claims) {
      const step = nextStep(
        claim,
        work?.chainTime ?? 0,
        mandate.challengeWindow,
      );
      if (
        step.kind === "payout" &&
        sameAddress(claim.record.contributor, wallet)
      ) {
        items.push({
          key: `payout-${claim.id}`,
          kind: "payout",
          text: "Your claim was approved. You can take your payout now.",
          action: "Take it",
          tab: "work",
          why: "It is your claim.",
          ifIgnored: "The payout waits until you take it.",
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
          text: `${who(claim.record.contributor)} filed a claim that needs your review.`,
          action: "Review it",
          tab: "work",
          ...(claim.record.expiresAt > 0
            ? { due: claim.record.expiresAt }
            : {}),
          why: "You are a reviewer on this work budget.",
          ifIgnored:
            claim.record.expiresAt > 0 &&
            (work?.chainTime ?? 0) > claim.record.expiresAt
              ? "Anyone can now close this unanswered claim and return its stake and reserved payment."
              : "After its deadline, anyone can close an unanswered claim and return its stake and reserved payment.",
        });
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
            : `Ready to run: ${titleOf(decision)}.`,
        action: "Open it",
        tab: "decisions",
        why: "Anyone can move an approved decision along.",
        ifIgnored: "It does not run until someone does.",
      });
    }
  }

  if (capacity > 0n) {
    for (const mandate of work?.mandates ?? []) {
      for (const claim of mandate.claims) {
        if (
          nextStep(claim, work?.chainTime ?? 0, mandate.challengeWindow)
            .kind === "award"
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
  "vote",
  "move",
  "award",
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
      return "Nothing is waiting. Work budgets are open for people to claim.";
    }
    // A DAO that has already done things is not "just starting": say that no work budget is open.
    return (counts.carriedOut ?? 0) > 0
      ? "Nothing is waiting, and no work budget is open. Put a decision to a vote to set work in motion."
      : "Nothing is going on yet. Put the first decision to a vote to set work in motion.";
  }
  return `${parts.join(" and ")}.`.replace(/^./, (c) => c.toUpperCase());
}
