/**
 * The supply split a launch commits to.
 *
 * A token launch is not just a sale: the shares that are *not* sold — team,
 * treasury, liquidity, milestone unlocks, community — decide what the token is
 * worth to whoever buys the sold part. The plan argues the shape in
 * `docs/dao-launchpad-plan.md` §7; this module is the default and the guardrail
 * (the parts must add up), not the policy.
 *
 * Alias-free on purpose: covered by `allocation.test.mjs`.
 */

export interface SupplyAllocation {
  sale: number;
  team: number;
  treasury: number;
  liquidity: number;
  milestones: number;
  community: number;
}

/** Sale first: it is the part a launch is priced from. */
export const ALLOCATION_LABELS: Array<{
  key: keyof SupplyAllocation;
  label: string;
  hint: string;
}> = [
  { key: "sale", label: "Sale", hint: "Sold in the auction." },
  {
    key: "team",
    label: "Team",
    hint: "Founders and contributors, locked with a cliff.",
  },
  { key: "treasury", label: "Treasury", hint: "Held by the DAO to spend." },
  {
    key: "liquidity",
    label: "Liquidity",
    hint: "Seeded at graduation, paired with the raise.",
  },
  {
    key: "milestones",
    label: "Milestones",
    hint: "Released against delivered, verified work.",
  },
  { key: "community", label: "Community", hint: "Grants, bounties, rewards." },
];

/**
 * The shape a project starts from: a fifth sold, the rest split between the
 * people who build it, the treasury that funds it, the liquidity it trades
 * against, milestone unlocks and the community.
 */
export const STANDARD_ALLOCATION: SupplyAllocation = {
  sale: 20,
  team: 20,
  treasury: 30,
  liquidity: 15,
  milestones: 10,
  community: 5,
};

/**
 * What a project that launches into its own DAO actually does with its supply: it sells the sale share, locks the team's
 * share behind the milestone schedule, and puts everything else in the DAO (`daoLaunch.ts` maps treasury, liquidity,
 * milestones and community into one DAO reserve). The six stored shares are not six funded destinations there, so the
 * launch shows three, and the DAO decides later what to do with its reserve. The record keeps its six numbers (older
 * launches and the other token modes use them); a DAO launch writes its whole reserve into `treasury`.
 */
export const DAO_RESERVE_KEYS = [
  "treasury",
  "liquidity",
  "milestones",
  "community",
] as const;

/**
 * The shape a new own-DAO launch starts from (D75): three quarters sold, a quarter for the team (all of it behind the
 * milestones), and no reserve in the DAO. The launch kit refuses a sale under 60%, a team over 35% and a reserve over
 * 20% (`LAUNCH_LIMITS` in the shared package).
 */
export const STANDARD_DAO_ALLOCATION: SupplyAllocation = {
  sale: 75,
  team: 25,
  treasury: 0,
  liquidity: 0,
  milestones: 0,
  community: 0,
};

/** The other two starting splits for an own-DAO launch: a smaller team, and the largest the kit allows. */
export const DAO_ALLOCATION_PRESETS: ReadonlyArray<{
  key: "standard" | "small-team" | "large-team";
  label: string;
  allocation: SupplyAllocation;
}> = [
  { key: "standard", label: "Standard", allocation: STANDARD_DAO_ALLOCATION },
  {
    key: "small-team",
    label: "Small team",
    allocation: { ...STANDARD_DAO_ALLOCATION, sale: 80, team: 20 },
  },
  {
    key: "large-team",
    label: "Large team",
    allocation: { ...STANDARD_DAO_ALLOCATION, sale: 65, team: 35 },
  },
];

/** The DAO's share: every part that is neither sold nor the team's. */
export function daoReserve(allocation: SupplyAllocation): number {
  return DAO_RESERVE_KEYS.reduce(
    (total, key) => total + (allocation[key] || 0),
    0,
  );
}

/** Set the DAO's share as one number: it all lives in `treasury`, and the other reserve parts are zero. */
export function withDaoReserve(
  allocation: SupplyAllocation,
  percent: number,
): SupplyAllocation {
  return {
    ...allocation,
    treasury: percent,
    liquidity: 0,
    milestones: 0,
    community: 0,
  };
}

/** The split a form starts from: the launch's own, else the standard one for the kind of token it will be. */
export function startingAllocation(
  saved: SupplyAllocation | null | undefined,
  ownDao: boolean,
): SupplyAllocation {
  return (
    saved ?? { ...(ownDao ? STANDARD_DAO_ALLOCATION : STANDARD_ALLOCATION) }
  );
}

const sameShares = (a: SupplyAllocation, b: SupplyAllocation) =>
  (Object.keys(a) as Array<keyof SupplyAllocation>).every(
    (key) => a[key] === b[key],
  );

/**
 * The split after the kind of token changes. A founder who has not touched the standard split gets the other kind's
 * standard one (an own DAO shows three shares, the other modes six); anything they edited stays as they set it.
 */
export function allocationForMode(
  allocation: SupplyAllocation,
  ownDao: boolean,
): SupplyAllocation {
  if (ownDao && sameShares(allocation, STANDARD_ALLOCATION)) {
    return { ...STANDARD_DAO_ALLOCATION };
  }
  if (!ownDao && sameShares(allocation, STANDARD_DAO_ALLOCATION)) {
    return { ...STANDARD_ALLOCATION };
  }
  return allocation;
}

/** One share edited. An own-DAO launch shows the DAO's share as one number, and it all lives in the treasury share. */
export function changeAllocation(
  allocation: SupplyAllocation,
  key: keyof SupplyAllocation,
  value: number,
  ownDao: boolean,
): SupplyAllocation {
  return ownDao && key === "treasury"
    ? withDaoReserve(allocation, value)
    : { ...allocation, [key]: value };
}

export interface AllocationRow {
  /** The stored share this row edits. */
  key: keyof SupplyAllocation;
  label: string;
  hint: string;
  share: number;
}

/** The three shares an own-DAO launch shows. */
export const DAO_ALLOCATION_LABELS: ReadonlyArray<{
  key: "sale" | "team" | "treasury";
  label: string;
  hint: string;
}> = [
  { key: "sale", label: "Public sale", hint: "Sold in the auction." },
  {
    key: "team",
    label: "Team allocation",
    hint: "Locked. Each part unlocks only when its milestone is reached.",
  },
  {
    key: "treasury",
    label: "DAO reserve",
    hint: "Held by the DAO. The holders decide by vote what to do with it.",
  },
];

/** What the team row says when the plan does not lock the team's Shares. */
const TEAM_UNLOCKED_HINT =
  "Not locked. The team holds these from the start and can move them.";

/**
 * The rows to show: three for a project launching into its own DAO, the six stored shares otherwise. `teamLocked` is
 * whether the plan locks the team's Shares behind milestones; the team row says what the plan really does, since the
 * wizard also allows no lock at all.
 */
export function allocationRows(
  allocation: SupplyAllocation,
  ownDao: boolean,
  teamLocked = true,
): AllocationRow[] {
  if (!ownDao) {
    return ALLOCATION_LABELS.map(({ key, label, hint }) => ({
      key,
      label,
      hint,
      share: allocation[key],
    }));
  }
  return DAO_ALLOCATION_LABELS.map(({ key, label, hint }) => ({
    key,
    label,
    hint: key === "team" && !teamLocked ? TEAM_UNLOCKED_HINT : hint,
    share: key === "treasury" ? daoReserve(allocation) : allocation[key],
  }));
}

export function totalAllocation(allocation: SupplyAllocation): number {
  return ALLOCATION_LABELS.reduce(
    (total, { key }) => total + (allocation[key] || 0),
    0,
  );
}

/**
 * Whether the split adds up.
 *
 * A token with 105% allocated is a token someone cannot have; the far more
 * common mistake is publishing without checking, which is why the form refuses
 * rather than warns.
 */
export function allocationIssue(allocation: SupplyAllocation): string | null {
  const total = totalAllocation(allocation);
  if (total === 100) return null;
  return total > 100
    ? `The allocation adds up to ${total}%. The parts cannot exceed the supply.`
    : `The allocation adds up to ${total}%. ${100 - total}% of the supply is unassigned.`;
}

/** Parse a stored allocation, falling back to the standard split. */
export function parseAllocation(value: unknown): SupplyAllocation {
  if (!value || typeof value !== "object") return { ...STANDARD_ALLOCATION };
  const source = value as Record<string, unknown>;
  const read = (key: keyof SupplyAllocation) => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? raw
      : STANDARD_ALLOCATION[key];
  };
  return {
    sale: read("sale"),
    team: read("team"),
    treasury: read("treasury"),
    liquidity: read("liquidity"),
    milestones: read("milestones"),
    community: read("community"),
  };
}

/**
 * Fully-diluted valuation implied by a floor price and a sale share.
 *
 * The buyer's number: what the whole supply is being priced at, not just the
 * tranche that is for sale. `salePricePerToken` is in currency smallest units.
 */
export function impliedFdv(
  salePricePerToken: bigint | null,
  totalSupply: bigint | null,
): bigint | null {
  if (salePricePerToken === null || totalSupply === null) return null;
  return salePricePerToken * totalSupply;
}

/** Tokens a budget buys at a given price, ignoring the clearing price move. */
export function tokensForBudget(
  budget: bigint | null,
  pricePerToken: bigint | null,
): bigint | null {
  if (budget === null || pricePerToken === null || pricePerToken === 0n) {
    return null;
  }
  return budget / pricePerToken;
}

/**
 * The minimum liquidity allocation so the day-one pool covers `raiseShareBps`
 * of the floor raise.
 *
 * MetaDAO seeds liquidity with 20% of the *raise*; our wizard allocates
 * percent of *supply*. The conversion is exact and supply-only (the plan's
 * "do not copy the number blindly" note): a pool holding `L%` of supply at
 * the floor is worth `L / sale%` of the raise, so covering `share/10000` of
 * the raise needs `liquidity >= sale% * share/10000` percent of supply.
 * For the standard shape (20% sale, 20% of the raise) that is 4%.
 *
 * A policy default, warning-grade — not a contract rule.
 */
export function minimumLiquidityPercent(input: {
  salePercent: number;
  raiseShareBps: number;
}): number | null {
  const { salePercent, raiseShareBps } = input;
  if (salePercent <= 0 || raiseShareBps <= 0) return null;
  const min = (salePercent * raiseShareBps) / 10_000;
  return min <= 0 ? null : min;
}
