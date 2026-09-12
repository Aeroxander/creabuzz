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
    ? `The allocation adds up to ${total}% — the parts cannot exceed the supply.`
    : `The allocation adds up to ${total}% — ${100 - total}% of the supply is unassigned.`;
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
