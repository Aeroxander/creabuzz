/**
 * How long a DAO's money lasts (N4): what it holds free to use, what it set aside for work and has not paid yet, what it
 * actually paid out, and, as an estimate, how many months the two together last at the last three months' pace.
 *
 * Kept apart so nothing is counted twice: moving money into a work budget is setting it aside, not spending it; money a
 * work budget pays to approved work is spending; money paid to someone leaving is neither (it is their part, D73).
 * Months left is never "unlimited": with under three months of history, or nothing paid in the last three months, it
 * says so instead of dividing by nothing.
 */

/** Three months, in seconds: the window the pace is measured over. */
export const PACE_WINDOW = 90 * 86_400;

/** One payment that counts as spending: who got it is not needed here, only how much and when. */
export interface Spend {
  amount: bigint;
  /** Unix seconds, or null when the block's time could not be read. */
  at: number | null;
}

/** One transfer of the DAO's currency out of its treasury. */
export interface Outflow {
  to: string;
  amount: bigint;
  tx: string | null;
  at: number | null;
}

/**
 * Sorts the treasury's outflows: into a work budget (set aside), to someone leaving (their part), or spent. A payment in
 * a transaction that also burned Shares or Loot is an exit; that is how leaving looks on chain, since it has no event of
 * its own.
 */
export function classifyOutflows(
  outflows: readonly Outflow[],
  budgets: readonly string[],
  exitTxs: ReadonlySet<string>,
): { setAside: Outflow[]; exits: Outflow[]; spent: Outflow[] } {
  const isBudget = new Set(budgets.map((b) => b.toLowerCase()));
  const out = {
    setAside: [] as Outflow[],
    exits: [] as Outflow[],
    spent: [] as Outflow[],
  };
  for (const o of outflows) {
    if (isBudget.has(o.to.toLowerCase())) out.setAside.push(o);
    else if (o.tx !== null && exitTxs.has(o.tx.toLowerCase()))
      out.exits.push(o);
    else out.spent.push(o);
  }
  return out;
}

export type Pace =
  /** Under three months of history: no pace to go by yet. */
  | { kind: "too-new" }
  /** Nothing paid in the last three months. */
  | { kind: "no-spending" }
  /** An estimate in whole months at the last three months' pace. */
  | { kind: "estimate"; months: number };

export interface Runway {
  /** What the treasury holds in the DAO's currency: what leaving draws on. Null when it could not be read. */
  free: bigint | null;
  /** Held in work budgets and reserved for submissions, not paid yet. Null when it could not be read. */
  setAside: bigint | null;
  /** Everything paid out so far, and of it what was paid in the last three months. */
  spentTotal: bigint;
  spentRecent: bigint;
  pace: Pace;
  /** Some payments could not be read or dated: the spending figures may be low. */
  incomplete: boolean;
}

/**
 * The card's figures. `bornAt` is when the project started (Unix seconds); `now` is the chain's own time.
 */
export function runway(input: {
  free: bigint | null;
  setAside: bigint | null;
  spends: readonly Spend[];
  incomplete: boolean;
  bornAt: number;
  now: number;
}): Runway {
  const { free, setAside, spends, now } = input;
  let spentTotal = 0n;
  let spentRecent = 0n;
  let undated = false;
  for (const s of spends) {
    spentTotal += s.amount;
    if (s.at === null) undated = true;
    else if (now - s.at < PACE_WINDOW) spentRecent += s.amount;
  }
  let pace: Pace;
  if (now - input.bornAt < PACE_WINDOW) {
    pace = { kind: "too-new" };
  } else if (spentRecent === 0n) {
    pace = { kind: "no-spending" };
  } else {
    const onHand = (free ?? 0n) + (setAside ?? 0n);
    // A month is a third of the window: months = on hand ÷ (spent in the window ÷ 3), rounded down.
    pace = {
      kind: "estimate",
      months: Number((onHand * 3n) / spentRecent),
    };
  }
  return {
    free,
    setAside,
    spentTotal,
    spentRecent,
    pace,
    incomplete: input.incomplete || undated,
  };
}

/** The months-left line, in plain words. */
export function paceLine(pace: Pace): string {
  switch (pace.kind) {
    case "too-new":
      return "Not enough history yet: it started under three months ago.";
    case "no-spending":
      return "Nothing was paid out in the last three months, so there is no pace to go by.";
    case "estimate":
      return pace.months === 1
        ? "About 1 month at the last three months' pace (an estimate)."
        : `About ${pace.months} months at the last three months' pace (an estimate).`;
  }
}
