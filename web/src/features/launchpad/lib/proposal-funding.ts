/**
 * The backer-directed side of a raise: vouchers, backing a proposal, and the
 * weight that backing earns (plan §4, docs/token-voting-design.md §3).
 *
 * This is the arithmetic `contracts/src/ProposalVault.sol` performs, kept in
 * step with it by `proposal-funding.test.mjs` — the numbers a backer is shown
 * before they commit must be the numbers the contract settles at. Nothing here
 * touches the chain: `use-proposals.ts` supplies the state, this file only
 * works out what it means.
 */

/** A funding proposal: what it needs, and what backs it. */
export interface FundingProposal {
  id: string;
  /** The acceptance check, written before anyone backed it (plan G16). */
  checkHash: string;
  /** Currency base units. */
  minAmount: string;
  maxAmount: string;
  /** Block after which nothing more may be committed. */
  deadline: number;
  /** Currency base units committed so far. */
  reserved: string;
  state: "open" | "verified" | "failed";
}

/** One act of backing. */
export interface BackingPosition {
  proposalId: string;
  /** Project tokens escrowed for this act. */
  tokens: string;
  /** Currency this act moved into the proposal's reserve. */
  currency: string;
  /** Block the commitment began — what its age is measured from. */
  startBlock: number;
}

export type Bigish = bigint | number | string;

export function toBig(value: Bigish): bigint {
  if (typeof value === "bigint") return value;
  // Tolerate the thousands separators people type into a money box, so a
  // figure written as `1_000` is the same figure the chain settles.
  return BigInt(
    typeof value === "number" ? value : value.replace(/[_,\s]/g, ""),
  );
}

/**
 * The tax on backing, in basis points. Deliberately the same integer maths as
 * the contract — rounding down, so a tax can never take a fraction more than
 * the chain will.
 */
export function backingTax(amount: Bigish, taxBps: number): bigint {
  return (toBig(amount) * BigInt(taxBps)) / 10_000n;
}

/** What reaches the proposal's reserve after the tax. */
export function reserveAfterTax(amount: Bigish, taxBps: number): bigint {
  return toBig(amount) - backingTax(amount, taxBps);
}

/**
 * Project tokens minted for a given commitment.
 *
 * `tokens = reserve × 1e18 / pricePerToken`, exactly as the contract computes
 * it: priced off the money that reached the reserve, so a tax can never buy
 * extra weight.
 */
export function tokensForReserve(
  reserve: Bigish,
  pricePerToken: Bigish,
): bigint {
  const price = toBig(pricePerToken);
  return price === 0n ? 0n : (toBig(reserve) * 10n ** 18n) / price;
}

/**
 * Whether a proposed price is allowed at all. The plan's one unbendable rule:
 * the price is never below the treasury's value per token, or buying and then
 * ragequitting is free money (plan §4).
 */
export function priceIsAllowed(
  pricePerToken: Bigish,
  floorPerToken: Bigish,
): boolean {
  return toBig(pricePerToken) >= toBig(floorPerToken);
}

/**
 * The `backing` term of a position's voting weight at a block
 * (docs/token-voting-design.md §3):
 *
 * ```
 * tokens × (1 + min(age / T, 1))
 * ```
 *
 * A commitment earns its stake back plus at most as much again, and only while
 * it is at risk. A position opened after `atBlock` counts for nothing.
 */
export function positionWeight(
  position: Pick<BackingPosition, "tokens" | "startBlock">,
  atBlock: number,
  maturationBlocks: number,
): bigint {
  const tokens = toBig(position.tokens);
  if (tokens === 0n || position.startBlock > atBlock) return 0n;
  if (maturationBlocks <= 0) return tokens;
  const age = BigInt(atBlock - position.startBlock);
  const matured =
    age >= BigInt(maturationBlocks) ? BigInt(maturationBlocks) : age;
  return tokens + (tokens * matured) / BigInt(maturationBlocks);
}

/** The backing weight behind one proposal, summed over every act of backing. */
export function backingWeight(
  positions: readonly BackingPosition[],
  proposalId: string,
  atBlock: number,
  maturationBlocks: number,
): bigint {
  let total = 0n;
  for (const position of positions) {
    if (position.proposalId !== proposalId) continue;
    total += positionWeight(position, atBlock, maturationBlocks);
  }
  return total;
}

/** Tokens still at risk: escrowed behind proposals that have not resolved. */
export function tokensAtRisk(
  positions: readonly BackingPosition[],
  isResolved: (proposalId: string) => boolean,
): bigint {
  let total = 0n;
  for (const position of positions) {
    if (isResolved(position.proposalId)) continue;
    total += toBig(position.tokens);
  }
  return total;
}

/** How much more a backer may commit before the proposal's cap binds. */
export function remainingRoom(proposal: FundingProposal): bigint {
  const max = toBig(proposal.maxAmount);
  const reserved = toBig(proposal.reserved);
  return max > reserved ? max - reserved : 0n;
}

/** Whether a proposal may be judged yet: enough committed, or out of time. */
export function isResolvable(
  proposal: FundingProposal,
  currentBlock: number,
): boolean {
  return (
    proposal.state === "open" &&
    (toBig(proposal.reserved) >= toBig(proposal.minAmount) ||
      currentBlock > proposal.deadline)
  );
}

/** Whether a proposal missed its minimum and may be closed by anyone. */
export function missedMinimum(
  proposal: FundingProposal,
  currentBlock: number,
): boolean {
  return (
    proposal.state === "open" &&
    currentBlock > proposal.deadline &&
    toBig(proposal.reserved) < toBig(proposal.minAmount)
  );
}

/** A short plain-words line for a proposal row: "950 of 1,000 backed". */
export function backingProgress(proposal: FundingProposal): string {
  const reserved = toBig(proposal.reserved);
  const min = toBig(proposal.minAmount);
  return `${reserved} of ${min} needed`;
}
