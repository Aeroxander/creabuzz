/**
 * Where a DAO's money has gone: through work budgets that pay only against reviewed claims, or straight out by a vote.
 *
 * A DAO can do both. A holder vote can set money aside in a work budget, where it leaves only for a claim the reviewers
 * approved, and the same kind of vote can also pay someone directly, with nobody checking anything. Both are legitimate,
 * and a backer deciding whether a team is accountable needs to see the split. This reads it from what the app already has
 * (the decisions the chain returned and the work budgets under them) and adds no reads of its own.
 *
 * It counts what it can read and says how much it could not: a decision that would move money but whose call this app
 * does not recognise is counted as unread, never as nothing. Only decisions that ran count, since a defeated one moved
 * nothing.
 *
 * The chain is the source and the decisions are bounded (the newest few), so the answer says when it was cut.
 */

import type { Decision } from "./decisions.ts";
import {
  decodeBatch,
  describeAction,
  type DescribeContext,
} from "./daoActions.ts";
import { describeDecision } from "./decisionDescribe.ts";
import { decodeParameters, selectorOf } from "./evmAbi.ts";
import type { WorkSnapshot } from "./workRead.ts";

const TRANSFER = selectorOf("transfer(address,uint256)").toLowerCase();

const same = (a: string, b: string | null) =>
  b !== null && a.toLowerCase() === b.toLowerCase();

/** One payment a decision made straight out of the treasury. */
export interface DirectPayment {
  /** Its place in the list, so a screen can tell two identical payments apart. */
  position: number;
  decisionId: string;
  to: string;
  amount: bigint;
}

export interface SpendingSummary {
  /** Money set aside in work budgets, in the DAO's currency: it leaves only against claims the reviewers approved. */
  reviewedBudget: bigint;
  /** Of that, what has been paid out to approved claims so far. */
  reviewedPaid: bigint;
  /** Work budgets in some other currency, not added to the figures above. */
  otherCurrencyBudgets: number;
  /** Money paid straight out of the treasury by decisions that ran, in the DAO's currency. */
  directTotal: bigint;
  direct: DirectPayment[];
  /** Decisions that ran, could move money, and are not a call this app recognises. */
  unread: number;
  /** How many decisions were read, out of how many the DAO has opened. */
  decisionsRead: number;
  decisionsTotal: number;
  /** There were more decisions than were read: the newest are counted, the oldest are not. */
  truncated: boolean;
  /** The work budgets were read. False means the reviewed-work figures are missing, not zero. */
  workRead: boolean;
  /** The work budgets or their claims were cut off at a bound, so the reviewed-work figures may be low. */
  workTruncated: boolean;
}

interface Input {
  decisions: readonly Decision[];
  decisionsTotal: number;
  truncated: boolean;
  work: WorkSnapshot | undefined;
  /** The DAO's money: an ERC-20 address, or null for the chain's own coin. */
  currency: string | null;
  /** What the app knows to be this DAO's own, so only real budgets and awards are described as such. */
  context: Pick<DescribeContext, "dao" | "factory" | "mandates">;
}

interface Call {
  to: string;
  value: bigint;
  data: string;
}

/** What one call does to the DAO's money, as far as it can be told. */
function classify(
  call: Call,
  currency: string | null,
  context: Input["context"],
): { direct: { to: string; amount: bigint } } | "unread" | "none" {
  const data = call.data.toLowerCase();
  // The chain's own coin sent with no call data is a plain payment.
  if (call.value > 0n && (data === "0x" || data === "")) {
    return currency === null
      ? { direct: { to: call.to, amount: call.value } }
      : "unread";
  }
  if (call.value > 0n) return "unread";
  if (
    currency !== null &&
    same(call.to, currency) &&
    data.startsWith(TRANSFER)
  ) {
    try {
      const [to, amount] = decodeParameters(
        ["address", "uint256"],
        `0x${data.slice(10)}`,
      ) as [string, bigint];
      return { direct: { to, amount } };
    } catch {
      return "unread";
    }
  }
  const described = describeAction(
    { to: call.to, data: call.data },
    {
      ...context,
      currency: currency ?? undefined,
    },
  );
  // A budget, a project, an award or a market move no money out of the treasury on their own (a budget's money is
  // counted from the budget itself); anything else may.
  return described.kind === "unknown" || described.kind === "batch"
    ? "unread"
    : "none";
}

export function summariseSpending(input: Input): SpendingSummary {
  const { decisions, work, currency, context } = input;
  let reviewedBudget = 0n;
  let reviewedPaid = 0n;
  let otherCurrencyBudgets = 0;
  for (const mandate of work?.mandates ?? []) {
    if (mandate.isMilestonePanel || mandate.created.budget === 0n) continue;
    if (currency === null || !same(mandate.created.currency, currency)) {
      otherCurrencyBudgets += 1;
      continue;
    }
    // A closed budget gave its unused money back to the DAO, so only what is still committed to a claim, or paid, counts
    // as set aside for reviewed work. An open one counts whole. Money is committed to a claim only once the claim is
    // bound to a project (that is when its funds are reserved): a claim that asks for 1,000 and was never taken on has
    // committed nothing, however it ended up (a frozen claim that was never bound reserved nothing).
    let committed = 0n;
    for (const claim of mandate.claims) {
      const { status, amount } = claim.record;
      if (claim.project === null) continue;
      if (status === "Paid") reviewedPaid += amount;
      if (
        status === "Paid" ||
        status === "Approved" ||
        status === "Frozen" ||
        status === "Open"
      ) {
        committed += amount;
      }
    }
    // What was set aside bounds what can be committed: a total above the budget is a misread, not more money.
    const bounded =
      committed > mandate.created.budget ? mandate.created.budget : committed;
    reviewedBudget += mandate.closed ? bounded : mandate.created.budget;
  }

  const direct: DirectPayment[] = [];
  let unread = 0;
  for (const decision of decisions) {
    if (decision.state !== "Executed") continue;
    const action = decision.action;
    if (action === null) {
      unread += 1; // it ran, and what it did could not be read back
      continue;
    }
    if (action.op === 1) {
      unread += 1; // a delegate call runs arbitrary code as the DAO
      continue;
    }
    // A budget (counted from the budget itself) and a market (Shares into a pool) take no money out of the treasury.
    const whole = describeDecision(
      { to: action.to, data: action.data },
      { ...context, currency: currency ?? undefined },
    );
    if (whole.kind === "work-budget" || whole.kind === "market") continue;
    // Several calls in one vote are the DAO's own batch; the same bytes sent anywhere else are something else.
    const batch =
      context.dao && same(action.to, context.dao)
        ? decodeBatch(action.data)
        : null;
    const calls: Call[] = batch ?? [
      { to: action.to, value: action.value, data: action.data },
    ];
    let unclear = false;
    for (const call of calls) {
      const result = classify(call, currency, context);
      if (result === "unread") unclear = true;
      else if (result !== "none") {
        direct.push({
          position: direct.length,
          decisionId: decision.id,
          to: result.direct.to,
          amount: result.direct.amount,
        });
      }
    }
    if (unclear) unread += 1;
  }

  return {
    reviewedBudget,
    reviewedPaid,
    otherCurrencyBudgets,
    directTotal: direct.reduce((sum, p) => sum + p.amount, 0n),
    direct,
    unread,
    decisionsRead: decisions.length,
    decisionsTotal: input.decisionsTotal,
    truncated: input.truncated,
    workRead: work !== undefined,
    workTruncated: Boolean(work?.truncated),
  };
}

/** The picture covers everything: every decision and every work budget was read, none could not be understood. */
export function spendingIsComplete(summary: SpendingSummary): boolean {
  return (
    summary.unread === 0 &&
    !summary.truncated &&
    summary.workRead &&
    !summary.workTruncated
  );
}

/**
 * How the picture reads in one plain sentence, for a headline. It claims only what was read: where something could not be
 * read or was cut off the sentence says so, and a headline never says money went both ways because something is unknown.
 */
export function spendingHeadline(summary: SpendingSummary): string {
  const complete = spendingIsComplete(summary);
  const reviewed = summary.reviewedBudget > 0n;
  const direct = summary.directTotal > 0n;
  if (!reviewed && !direct) {
    return complete
      ? "No money has left the treasury by a decision yet."
      : "No money could be traced leaving the treasury by a decision, but this page could not read everything.";
  }
  if (!direct) {
    return complete
      ? "Everything that has left the treasury went through reviewed work budgets."
      : "Everything this page could read that has left the treasury went through reviewed work budgets, but it could not read everything.";
  }
  if (!reviewed) {
    return complete
      ? "Money has left the treasury by direct payment only. No reviewer checked any of it."
      : "The money this page could read that left the treasury was paid out directly, with no reviewer checking any of it, and it could not read everything.";
  }
  return `Some money went through reviewed work budgets, and some was paid out directly with no reviewer.${complete ? "" : " This page could not read everything."}`;
}
