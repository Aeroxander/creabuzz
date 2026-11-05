/**
 * A DAO's public record, as data: what it holds, what it has paid and to whom, what the team was promised against and
 * has earned, and what happened and when.
 *
 * It is built only from what the chain returned (the work and decision reads, plus `record-read.ts`'s logs), so every
 * line can be checked against the contracts by anyone. Nothing here comes from a record somebody wrote about the DAO.
 * What is missing is said, not smoothed over: an undated entry says it has no date, and a history that was cut short
 * says so.
 *
 * Wording is plain: the page is for backers and newcomers, not for people who read contracts. Alias-free for
 * `node --test`.
 */

import type {
  Decision,
  DecisionState,
} from "@creaton/core/launchpad/decisions.ts";
import {
  claimKey,
  type RecordEvents,
  type TeamPromise,
} from "./record-read.ts";
import type {
  MandateView,
  WorkSnapshot,
} from "@creaton/core/launchpad/workRead.ts";

/** How the page writes a person, an amount and a title. Injected so this file needs no formatting code. */
export interface Labels {
  person: (address: string) => string;
  /** An amount of the mandate's currency, with its symbol. */
  money: (mandate: MandateView, atomic: bigint) => string;
  shares: (atomic: bigint) => string;
  title: (decision: Decision) => string;
  /** A milestone as the page names it: its number, and its words when the launch record has them. */
  milestone: (checkHash: string, index: number) => string;
}

export interface CurrencyFigures {
  currency: string;
  symbol: string;
  decimals: number;
  /** What the DAO's votes set aside for work, in all. */
  approved: bigint;
  /** What contributors have taken out. */
  paid: bigint;
  /** Asked for by work that is filed or approved but not yet taken. */
  waiting: bigint;
}

/** Money per currency (nearly always one): approved, paid and waiting. Mandates that move no currency are left out. */
export function moneyFigures(work: WorkSnapshot): CurrencyFigures[] {
  const byCurrency = new Map<string, CurrencyFigures>();
  for (const mandate of work.mandates) {
    if (mandate.currency === null) continue;
    const key = mandate.created.currency.toLowerCase();
    const figures = byCurrency.get(key) ?? {
      currency: key,
      symbol: mandate.currency.symbol,
      decimals: mandate.currency.decimals,
      approved: 0n,
      paid: 0n,
      waiting: 0n,
    };
    figures.approved += mandate.created.budget;
    for (const claim of mandate.claims) {
      if (claim.record.status === "Paid") figures.paid += claim.record.amount;
      if (
        claim.record.status === "Open" ||
        claim.record.status === "Approved"
      ) {
        figures.waiting += claim.record.amount;
      }
    }
    byCurrency.set(key, figures);
  }
  return [...byCurrency.values()];
}

export interface WorkFigures {
  filed: number;
  paid: number;
  /** Filed or approved, not yet finished. */
  inReview: number;
  /** Turned down, expired, frozen or unwound: the work that did not get paid. */
  notPaid: number;
  /** Shares the DAO has actually awarded for work, in all. */
  sharesAwarded: bigint;
  /** Shares the DAO has set aside for projects, awarded or not. */
  sharesSetAside: bigint;
}

export function workFigures(work: WorkSnapshot): WorkFigures {
  const out: WorkFigures = {
    filed: 0,
    paid: 0,
    inReview: 0,
    notPaid: 0,
    sharesAwarded: 0n,
    sharesSetAside: 0n,
  };
  for (const mandate of work.mandates) {
    // `sharesAllocated` is what projects were given to award; what was awarded is counted on each project.
    out.sharesSetAside += mandate.sharesAllocated;
    for (const project of mandate.projects) {
      out.sharesAwarded += project.record.sharesAwarded;
    }
    for (const claim of mandate.claims) {
      out.filed += 1;
      switch (claim.record.status) {
        case "Paid":
          out.paid += 1;
          break;
        case "Open":
        case "Approved":
          out.inReview += 1;
          break;
        default:
          out.notPaid += 1;
      }
    }
  }
  return out;
}

export interface PromiseFigures {
  /** Team members whose Shares have milestones behind them. */
  people: number;
  milestones: number;
  reached: number;
  /** Shares still held back. */
  held: bigint;
  /** Shares freed by a milestone. */
  freed: bigint;
  /** Shares the DAO took back from a team member who left. */
  givenUp: bigint;
}

export function promiseFigures(
  promises: readonly TeamPromise[],
): PromiseFigures {
  const out: PromiseFigures = {
    people: promises.length,
    milestones: 0,
    reached: 0,
    held: 0n,
    freed: 0n,
    givenUp: 0n,
  };
  for (const person of promises) {
    out.held += person.locked;
    for (const tranche of person.tranches) {
      out.milestones += 1;
      if (tranche.unlocked) {
        out.reached += 1;
        out.freed += tranche.amount;
      }
      if (tranche.forfeited) out.givenUp += tranche.amount;
    }
  }
  return out;
}

export interface DecisionFigures {
  open: number;
  ran: number;
  didNotPass: number;
}

const OPEN: readonly DecisionState[] = ["Active", "Queued", "Succeeded"];

export function decisionFigures(
  decisions: readonly Decision[],
): DecisionFigures {
  const out: DecisionFigures = { open: 0, ran: 0, didNotPass: 0 };
  for (const decision of decisions) {
    if (OPEN.includes(decision.state)) out.open += 1;
    else if (decision.state === "Executed") out.ran += 1;
    else if (decision.state === "Defeated" || decision.state === "Expired") {
      out.didNotPass += 1;
    }
  }
  return out;
}

export type LedgerKind = "decision" | "work" | "pay" | "milestone";

export interface LedgerEntry {
  key: string;
  /** Unix seconds, or 0 when the chain gave no date for it. Dated entries come first, newest first. */
  when: number;
  kind: LedgerKind;
  text: string;
  /** What became of it, or who said what. */
  detail?: string;
  /** The tab where the thing itself is, when there is one. */
  tab: "decisions" | "work" | null;
  /** The transaction it happened in, when the chain gave one (a payout), so the page can link it. */
  tx?: string;
}

const DECISION_WORDS: Record<DecisionState, string> = {
  Unopened: "Not opened",
  Active: "Open for votes",
  Queued: "Approved, waiting to take effect",
  Succeeded: "Approved, ready to start its wait",
  Defeated: "Did not pass",
  Expired: "Ran out of time without passing",
  Executed: "Approved and carried out",
};

/** What became of a claim, in a sentence. */
function claimOutcome(
  status: string,
  approvals: number,
  quorum: number,
): string {
  switch (status) {
    case "Open":
      return `Waiting for reviewers: ${approvals} of ${quorum} approvals.`;
    case "Approved":
      return "Approved by the reviewers. Waiting out the challenge window before it is paid.";
    case "Paid":
      return "Approved by the reviewers and paid.";
    case "Rejected":
      return "Turned down by the reviewers. Nothing was paid.";
    case "Expired":
      return "Ran out of time before it was approved. Nothing was paid.";
    case "Frozen":
      return "Frozen by the project while it is checked. Nothing is paid meanwhile.";
    case "Recovered":
      return "Rejected by the project after it was frozen.";
    default:
      return "";
  }
}

export interface LedgerInput {
  work: WorkSnapshot;
  decisions: readonly Decision[];
  events: RecordEvents;
  labels: Labels;
}

/** Everything that happened, newest first; entries with no date at the end. */
export function buildLedger(input: LedgerInput): LedgerEntry[] {
  const { work, decisions, events, labels } = input;
  const entries: LedgerEntry[] = [];

  for (const mandate of work.mandates) {
    for (const claim of mandate.claims) {
      const key = claimKey(mandate.address, claim.id);
      const who = labels.person(claim.record.contributor);
      const asked =
        claim.record.amount > 0n
          ? ` for ${labels.money(mandate, claim.record.amount)}`
          : " to be recognised";
      const verdicts = events.verdicts.get(key) ?? [];
      const approvedBy = verdicts
        .filter((v) => v.approve)
        .map((v) => labels.person(v.reviewer));
      const objectedBy = verdicts
        .filter((v) => !v.approve)
        .map((v) => labels.person(v.reviewer));

      entries.push({
        key: `filed-${key}`,
        when: events.filedAt.get(key) ?? 0,
        kind: "work",
        text: `${who} submitted work${asked}.`,
        detail:
          [
            claimOutcome(claim.record.status, claim.approvals, claim.quorum),
            objectedBy.length > 0
              ? `Objected to by ${objectedBy.join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined,
        tab: "work",
      });

      const said: string[] = [];
      if (approvedBy.length > 0)
        said.push(`Approved by ${approvedBy.join(", ")}.`);
      if (objectedBy.length > 0)
        said.push(`Objected to by ${objectedBy.join(", ")}.`);
      if (
        (claim.record.status === "Approved" ||
          claim.record.status === "Paid") &&
        claim.record.releasedAt > 0
      ) {
        entries.push({
          key: `approved-${key}`,
          when: claim.record.releasedAt,
          kind: "work",
          text: `The reviewers approved the work of ${who}.`,
          detail: said.join(" ") || undefined,
          tab: "work",
        });
      }

      const paidAt = events.paidAt.get(key);
      if (claim.record.status === "Paid") {
        entries.push({
          key: `paid-${key}`,
          when: paidAt ?? 0,
          kind: "pay",
          text:
            claim.record.amount > 0n
              ? `${who} was paid ${labels.money(mandate, claim.record.amount)}.`
              : `${who} was recognised for the work.`,
          tab: "work",
          tx: events.paidTx.get(key),
        });
      }
    }
  }

  for (const person of events.promises) {
    for (const tranche of person.tranches) {
      const who = labels.person(person.holder);
      if (tranche.unlocked) {
        entries.push({
          key: `milestone-${person.holder}-${tranche.index}`,
          when: tranche.reachedAt ?? 0,
          kind: "milestone",
          text: `${who} reached ${labels.milestone(tranche.checkHash, tranche.index)}. ${labels.shares(tranche.amount)} Shares were freed.`,
          tab: null,
        });
      } else if (tranche.forfeited) {
        entries.push({
          key: `gave-up-${person.holder}-${tranche.index}`,
          when: 0,
          kind: "milestone",
          text: `The project took back ${labels.shares(tranche.amount)} Shares that ${who} had not earned yet.`,
          tab: null,
        });
      }
    }
  }

  for (const decision of decisions) {
    entries.push({
      key: `decision-${decision.id}`,
      when: decision.openedAt,
      kind: "decision",
      text: `Decision opened: ${labels.title(decision)}.`,
      detail: DECISION_WORDS[decision.state],
      tab: "decisions",
    });
  }

  return entries.sort((a, b) => {
    if ((a.when === 0) !== (b.when === 0)) return a.when === 0 ? 1 : -1;
    if (a.when !== b.when) return b.when - a.when;
    return a.key < b.key ? -1 : 1;
  });
}

/**
 * Things a careful reader should know, said plainly. Each one is something the data shows; none is a judgement.
 * An empty list means there is nothing to add.
 */
export function watchNotes(input: {
  work: WorkSnapshot;
  events: RecordEvents;
  labels: Pick<Labels, "person">;
}): string[] {
  const { work, events, labels } = input;
  const notes: string[] = [];

  if (work.truncated || work.mandates.some((m) => m.truncated)) {
    notes.push(
      "This project has more work than is shown here. Only the newest is counted, so the totals can be too low.",
    );
  }
  if (events.truncated) {
    notes.push(
      "Some of the history is older than what was read, so the list of what happened starts partway through.",
    );
  }

  // Who has been approving. Reviewers are chosen by the DAO, and a panel that always agrees is worth a look.
  const approvals = new Map<string, number>();
  let total = 0;
  for (const verdicts of events.verdicts.values()) {
    for (const verdict of verdicts) {
      if (!verdict.approve) continue;
      total += 1;
      approvals.set(
        verdict.reviewer,
        (approvals.get(verdict.reviewer) ?? 0) + 1,
      );
    }
  }
  if (total >= 3 && approvals.size === 1) {
    const [only] = [...approvals.keys()];
    notes.push(
      `Every approval so far (${total}) came from the same reviewer, ${labels.person(only)}.`,
    );
  }

  if (events.lock === null) {
    notes.push(
      "Nobody's Shares are held back behind milestones in this project, so the team can sell theirs whenever they like.",
    );
  }
  return notes;
}
