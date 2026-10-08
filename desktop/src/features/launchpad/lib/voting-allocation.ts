/** Shares have 18 decimals. An allocation is movable support, without a credit balance. */
export const ALL_VOTING_SHARES = (1n << 256n) - 1n;
export const VOTING_OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
const CONVICTION_SCALE = 10n ** 18n;
const MAX_CONVICTION = ((1n << 96n) - 1n) * CONVICTION_SCALE;
const MAX_CAPACITY = (1n << 96n) - 1n;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
function proposalId(id: string): bigint {
  const value = BigInt(id);
  if (value < 0n || value > ALL_VOTING_SHARES)
    throw new Error("Invalid proposal id.");
  return value;
}
function decode(data: string, length: number): bigint[] {
  if (!new RegExp(`^0x[0-9a-fA-F]{${length * 64}}$`).test(data))
    throw new Error("The DAO voting response could not be read.");
  return Array.from({ length }, (_, i) =>
    BigInt(`0x${data.slice(2 + i * 64, 66 + i * 64)}`),
  );
}
/** Exact target allocation; zero withdraws an existing position. */
export function parseVotingShares(input: string): bigint {
  const value = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(value))
    throw new Error("Enter a Shares amount with at most 18 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (wei > MAX_CAPACITY)
    throw new Error("The Shares amount exceeds the supported range.");
  return wei;
}
/** Exact Shares display, including sub-token allocations. */
export function formatVotingShares(wei: bigint): string {
  const fraction = (wei % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${wei / 10n ** 18n}${fraction ? `.${fraction}` : ""}`;
}
/** Conviction is displayed in Shares, retaining fractional wei internally. */
export function formatVotingConviction(value: bigint): string {
  const fraction = (value % 10n ** 36n)
    .toString()
    .padStart(36, "0")
    .replace(/0+$/, "");
  // Keep ordinary accrued support readable; tiny values retain meaningful digits.
  const display =
    value >= 10n ** 30n ? fraction.slice(0, 6).replace(/0+$/, "") : fraction;
  return `${value / 10n ** 36n}${display ? `.${display}` : ""}`;
}

/** Getter includes free, owned, eligible target and this proposal's current allocation. */
export function encodeVotingAllocationFor(id: string, owner: string): string {
  if (!VOTING_OWNER_RE.test(owner))
    throw new Error("Enter a valid voting owner address.");
  return `0x54b31217${word(proposalId(id))}${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}
export interface VotingAllocation {
  available: bigint;
  owned: bigint;
  eligible: bigint;
  amount: bigint;
  side: number;
}
/** Reject malformed or internally inconsistent live chain previews. */
export function decodeVotingAllocation(data: string): VotingAllocation {
  const [available, owned, eligible, amount, side] = decode(data, 5);
  if (
    [available, owned, eligible, amount].some((v) => v > MAX_CAPACITY) ||
    available > owned ||
    amount > owned ||
    eligible > owned ||
    eligible > available + amount ||
    side > 2n
  )
    throw new Error("The voting allocation response is inconsistent.");
  return { available, owned, eligible, amount, side: Number(side) };
}
export interface VotingRules {
  quorum: bigint;
  currentYes: bigint;
  convictionYes: bigint;
  reviewEndsAt: bigint;
  expiresAt: bigint;
  delay: bigint;
  bounded: boolean;
}
/** Opening freezes these requirements; later settings cannot change them. */
export function encodeVotingRules(id: string): string {
  return `0xb1f792c9${word(proposalId(id))}`;
}
export function decodeVotingRules(data: string): VotingRules | null {
  const w = decode(data, 7);
  if (
    w.slice(0, 2).some((v) => v > MAX_CAPACITY) ||
    w[2] > MAX_CONVICTION ||
    w.slice(3, 6).some((v) => v > (1n << 64n) - 1n) ||
    w[6] > 1n
  )
    throw new Error("The voting rules response is inconsistent.");
  if (w[4] === 0n) return null;
  if (w[4] <= w[3] || w[5] === 0n)
    throw new Error("The voting rules response is inconsistent.");
  return {
    quorum: w[0],
    currentYes: w[1],
    convictionYes: w[2],
    reviewEndsAt: w[3],
    expiresAt: w[4],
    delay: w[5],
    bounded: w[6] === 1n,
  };
}
export interface VotingSupport {
  yes: bigint;
  no: bigint;
  abstain: bigint;
  convictionYes: bigint;
  convictionNo: bigint;
  convictionAbstain: bigint;
}
/** Current and matured support are distinct gates on the same allocations. */
export function encodeVotingSupport(id: string): string {
  return `0x4bcaf6aa${word(proposalId(id))}`;
}
export function decodeVotingSupport(data: string): VotingSupport {
  const w = decode(data, 6);
  if (
    w.slice(0, 3).some((v) => v > MAX_CAPACITY) ||
    w.slice(3).some((v) => v > MAX_CONVICTION) ||
    w[3] > w[0] * CONVICTION_SCALE ||
    w[4] > w[1] * CONVICTION_SCALE ||
    w[5] > w[2] * CONVICTION_SCALE
  )
    throw new Error("The voting support response is inconsistent.");
  return {
    yes: w[0],
    no: w[1],
    abstain: w[2],
    convictionYes: w[3],
    convictionNo: w[4],
    convictionAbstain: w[5],
  };
}
/** Explain captured approval gates without treating them as a fixed voting close. */
export function votingRulesSummary(
  rules: VotingRules | null | undefined,
): string {
  if (!rules)
    return "Proposal rules unavailable until opened and read from chain.";
  const date = (v: bigint) => new Date(Number(v) * 1000).toLocaleString();
  const delay =
    rules.delay % 86400n === 0n
      ? `${rules.delay / 86400n} days`
      : rules.delay % 3600n === 0n
        ? `${rules.delay / 3600n} hours`
        : `${rules.delay} seconds`;
  return `${rules.bounded ? "Bounded project" : "Unrestricted action"} · Current FOR ≥ ${formatVotingShares(rules.currentYes)} Shares · Matured FOR ≥ ${formatVotingConviction(rules.convictionYes)} · Turnout ≥ ${formatVotingShares(rules.quorum)} · Current FOR must beat AGAINST · Earliest approval ${date(rules.reviewEndsAt)} · Expires ${date(rules.expiresAt)} · Execution delay ${delay}`;
}
/** A current backing deficit cannot be repaired merely by waiting for conviction. */
export function votingRuleWatch(
  rules: VotingRules,
  support: VotingSupport,
  now: bigint,
): {
  status: "leading" | "needs-votes" | "at-risk" | "expired";
  detail: string;
} {
  if (now >= rules.expiresAt)
    return {
      status: "expired",
      detail: "Expired; allocations are available for other proposals.",
    };
  const needed = [
    rules.currentYes - support.yes,
    support.no + 1n - support.yes,
    rules.quorum - support.yes - support.no - support.abstain,
    0n,
  ].reduce((a, b) => (a > b ? a : b));
  const mature = support.convictionYes >= rules.convictionYes;
  const ready = needed === 0n && mature && now >= rules.reviewEndsAt;
  return {
    status: ready
      ? "leading"
      : rules.expiresAt - now <= 12n * 3600n
        ? "at-risk"
        : "needs-votes",
    detail: `Current FOR ${formatVotingShares(support.yes)} / AGAINST ${formatVotingShares(support.no)} · Matured FOR ${formatVotingConviction(support.convictionYes)} · ${needed > 0n ? `${formatVotingShares(needed)} more current FOR needed` : !mature ? "Support needs more conviction" : now < rules.reviewEndsAt ? "Minimum review period continues" : "Approval gates met; execution needs the full timelock"}. Support remains movable until execution.`,
  };
}
