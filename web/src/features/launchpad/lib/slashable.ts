/**
 * Which reviewers' bonds the DAO can take, and how much.
 *
 * A reviewer who asks for their whole bond back has a stake of zero from that moment, but the bond waits out a delay
 * and stays slashable the whole time (`VerifierSet.slash` takes the stake first, then what is waiting). Listing only
 * active stake would drop that reviewer from the form during the very period the delay exists for. So both are counted.
 *
 * Pure and alias-free: `slashable.test.mjs` drives it under `node --test`.
 */

interface SlashReviewer {
  address: string;
  stake: bigint | null;
  pending: { amount: bigint; availableAt: number } | null;
  pendingUnreadable: boolean;
}

interface SlashMandate {
  address: string;
  /** The bond's terms, null when the budget has none or they could not be read. */
  bond: { decimals: number; symbol: string; decimalsKnown: boolean } | null;
  bondUnreadable: boolean;
  reviewers: readonly SlashReviewer[];
}

export interface Slashable<M extends SlashMandate> {
  mandate: M;
  reviewer: M["reviewers"][number];
  /** Bond that still counts toward judging. */
  active: bigint;
  /** Bond asked back and not yet taken: still slashable until it is. */
  waiting: bigint;
  /** When the waiting part can be taken back (after which the reviewer may take it before the DAO does). */
  waitingUntil: number | null;
  /** The most the DAO can take now: both parts. */
  total: bigint;
  /** A pending amount could not be read, so `total` may be low. */
  waitingUnreadable: boolean;
}

export interface SlashableList<M extends SlashMandate> {
  entries: Slashable<M>[];
  /** Budgets whose bond terms could not be read: their reviewers cannot be listed with a unit. */
  unreadableBudgets: number;
  /** Budgets whose bond token did not say its decimals: an amount cannot be shown or typed against it safely. */
  unscaledBudgets: number;
}

export function slashableReviewers<M extends SlashMandate>(
  mandates: readonly M[],
): SlashableList<M> {
  const entries: Slashable<M>[] = [];
  let unreadableBudgets = 0;
  let unscaledBudgets = 0;
  for (const mandate of mandates) {
    if (mandate.bondUnreadable) unreadableBudgets += 1;
    if (!mandate.bond) continue;
    // Raw balances are still right, but the slash form takes a typed amount: never against a guessed scale.
    if (!mandate.bond.decimalsKnown) {
      unscaledBudgets += 1;
      continue;
    }
    for (const reviewer of mandate.reviewers) {
      const active = reviewer.stake ?? 0n;
      const waiting = reviewer.pending?.amount ?? 0n;
      const total = active + waiting;
      // A reviewer with nothing readable to take is still listed when a pending amount could not be read: there may be
      // a bond waiting, and dropping them would hide it.
      if (total === 0n && !reviewer.pendingUnreadable) continue;
      entries.push({
        mandate,
        reviewer: reviewer as M["reviewers"][number],
        active,
        waiting,
        waitingUntil: reviewer.pending?.availableAt ?? null,
        total,
        waitingUnreadable: reviewer.pendingUnreadable,
      });
    }
  }
  return { entries, unreadableBudgets, unscaledBudgets };
}
