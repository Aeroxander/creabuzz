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
    // as set aside for reviewed work. An open one counts whole.
    let committed = 0n;
    for (const claim of mandate.claims) {
      const { status, amount } = claim.record;
      if (status === "Paid") reviewedPaid += amount;
      if (
        status === "Paid" ||
        status === "Approved" ||
        status === "Frozen" ||
        (status === "Open" && claim.project !== null)
      ) {
        committed += amount;
      }
    }
    reviewedBudget += mandate.closed ? committed : mandate.created.budget;
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
  };
}

/** How the picture reads in one plain sentence, for a headline. */
export function spendingHeadline(summary: SpendingSummary): string {
  const anyMoney =
    summary.reviewedBudget > 0n ||
    summary.directTotal > 0n ||
    summary.unread > 0;
  if (!anyMoney) return "No money has left the treasury by a decision yet.";
  if (summary.directTotal === 0n && summary.unread === 0) {
    return "Everything that has left the treasury went through reviewed work budgets.";
  }
  if (summary.reviewedBudget === 0n && summary.unread === 0) {
    return "Money has left the treasury by direct payment only. No reviewer checked any of it.";
  }
  return "Some money went through reviewed work budgets, and some was paid out directly with no reviewer.";
}
