/**
 * What closing a work budget would cost that the vote's first lines do not say. Closing stops new claims and returns
 * unused money, but it also ends the budget's Shares allowance: the contract refuses every later award through it
 * (`consumeContribution` reverts once the budget is closed). Work that was approved and paid but not yet awarded Shares
 * would then never be awarded them, and any allowance left unused is gone.
 *
 * Pure and alias-free: `close-effects.test.mjs` drives it under `node --test`.
 */

interface ClosableMandate {
  claims: readonly {
    project: string | null;
    sharesAwarded: boolean;
    record: { status: string };
  }[];
  projects: readonly {
    record: { shareBudget: bigint; sharesAwarded: bigint };
  }[];
  /** The Shares the budget may award in all, and those it has given to work areas so far (when read). */
  created?: { shareBudget: bigint };
  sharesAllocated?: bigint;
  /** The mandate's history was cut at a bound, so these counts may be low. */
  truncated?: boolean;
}

export interface CloseEffects {
  /** Claims that were approved and paid, belong to a project, and are still waiting for their Shares award. */
  awardsLost: number;
  /** Shares left in the budget's work areas that would never be awarded. */
  allowanceLost: bigint;
  /** Shares of the budget not yet given to any work area, given up too. */
  unallocatedLost: bigint;
  /** The counts above may be low because the budget's history was cut off. */
  incomplete: boolean;
}

export function closeEffects(mandate: ClosableMandate): CloseEffects {
  const awardsLost = mandate.claims.filter(
    (claim) =>
      claim.record.status === "Paid" &&
      claim.project !== null &&
      !claim.sharesAwarded,
  ).length;
  let allowanceLost = 0n;
  for (const project of mandate.projects) {
    const left = project.record.shareBudget - project.record.sharesAwarded;
    if (left > 0n) allowanceLost += left;
  }
  const unallocated =
    mandate.created && mandate.sharesAllocated !== undefined
      ? mandate.created.shareBudget - mandate.sharesAllocated
      : 0n;
  return {
    awardsLost,
    allowanceLost,
    unallocatedLost: unallocated > 0n ? unallocated : 0n,
    incomplete: Boolean(mandate.truncated),
  };
}
