/**
 * Shares have 18 decimals. Backing is a movable, exclusive allocation without a credit balance; opposition
 * is free. The bars a proposal must clear are frozen when it opens. Shared by the web and desktop apps.
 */
export const ALL_VOTING_SHARES = (1n << 256n) - 1n;
export const VOTING_OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
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
/** Getter includes free, owned, eligible target and this proposal's current allocation. */
export function encodeVotingAllocationFor(id: string, owner: string): string {
  if (!VOTING_OWNER_RE.test(owner))
    throw new Error("Enter a valid voting owner address.");
  return `0x54b31217${word(proposalId(id))}${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}
export interface VotingAllocation {
  /** Shares not committed to backing anything. */
  available: bigint;
  owned: bigint;
  /** The most that can back (FOR or ABSTAIN) this proposal. */
  eligible: bigint;
  /** What is allocated here now, on whichever side. */
  amount: bigint;
  side: number;
  /** The most that can be set AGAINST this proposal; opposition never uses up Shares. */
  opposable: bigint;
}
/** Reject malformed or internally inconsistent live chain previews. */
export function decodeVotingAllocation(data: string): VotingAllocation {
  const [available, owned, eligible, amount, side, opposable] = decode(data, 6);
  if (
    [available, owned, eligible, amount, opposable].some(
      (v) => v > MAX_CAPACITY,
    ) ||
    available > owned ||
    amount > owned ||
    eligible > owned ||
    opposable > owned ||
    eligible > available + amount ||
    side > 2n
  )
    throw new Error("The voting allocation response is inconsistent.");
  return {
    available,
    owned,
    eligible,
    amount,
    side: Number(side),
    opposable,
  };
}
const MAX_UINT64 = (1n << 64n) - 1n;

export interface VotingRules {
  /** Shares that could vote, captured at the snapshot: supply minus the DAO's own, burned and excluded. */
  votingSupply: bigint;
  /** Shares that must take part (for, against or abstain). */
  quorum: bigint;
  /** An absolute floor of Shares in favour from the DAO's own settings (zero when unused). */
  minYes: bigint;
  /** Share of the votes cast for or against that must be in favour, in basis points. */
  approvalBps: bigint;
  reviewEndsAt: bigint;
  expiresAt: bigint;
  delay: bigint;
  /** How long quorum and approval must have held without a break. */
  hold: bigint;
  bounded: boolean;
  /** Whether backing here draws from one pool of Shares (a holder splits their Shares between proposals). */
  exclusive: boolean;
}
/** Opening freezes these requirements; later settings cannot change them. */
export function encodeVotingRules(id: string): string {
  return `0xb1f792c9${word(proposalId(id))}`;
}
export function decodeVotingRules(data: string): VotingRules | null {
  const w = decode(data, 10);
  if (
    w.slice(0, 3).some((v) => v > MAX_CAPACITY) ||
    w[3] > 10_000n ||
    w.slice(4, 8).some((v) => v > MAX_UINT64) ||
    w[8] > 1n ||
    w[9] > 1n
  )
    throw new Error("The voting rules response is inconsistent.");
  if (w[5] === 0n) return null;
  if (w[5] <= w[4] || w[6] === 0n || w[3] <= 5000n)
    throw new Error("The voting rules response is inconsistent.");
  return {
    votingSupply: w[0],
    quorum: w[1],
    minYes: w[2],
    approvalBps: w[3],
    reviewEndsAt: w[4],
    expiresAt: w[5],
    delay: w[6],
    hold: w[7],
    bounded: w[8] === 1n,
    exclusive: w[9] === 1n,
  };
}
export interface VotingSupport {
  yes: bigint;
  no: bigint;
  abstain: bigint;
  /** Since when quorum and approval have held; zero while they do not. */
  qualifiedSince: bigint;
}
/** Current allocations on the one authoritative ballot. */
export function encodeVotingSupport(id: string): string {
  return `0x4bcaf6aa${word(proposalId(id))}`;
}
export function decodeVotingSupport(data: string): VotingSupport {
  const w = decode(data, 4);
  if (w.slice(0, 3).some((v) => v > MAX_CAPACITY) || w[3] > MAX_UINT64)
    throw new Error("The voting support response is inconsistent.");
  return { yes: w[0], no: w[1], abstain: w[2], qualifiedSince: w[3] };
}
function span(seconds: bigint): string {
  if (seconds % 86400n === 0n) return `${seconds / 86400n} days`;
  if (seconds % 3600n === 0n) return `${seconds / 3600n} hours`;
  return `${seconds} seconds`;
}
/** Explain the frozen bars in plain words, without treating them as a fixed voting close. */
export function votingRulesSummary(
  rules: VotingRules | null | undefined,
): string {
  if (!rules)
    return "Proposal rules unavailable until opened and read from chain.";
  const date = (v: bigint) => new Date(Number(v) * 1000).toLocaleString();
  const percent = Number(rules.approvalBps) / 100;
  return `${rules.bounded ? "Approval inside a funded budget" : "Treasury-level action"} · At least ${formatVotingShares(rules.quorum)} Shares must take part · ${percent}% of the votes cast must be in favour · Support has to hold for ${span(rules.hold)} · Earliest approval ${date(rules.reviewEndsAt)} · Expires ${date(rules.expiresAt)} · Waits ${span(rules.delay)} after approval${rules.exclusive ? " · Shares you back here are not available to back another proposal" : ""}`;
}
/** Shares still needed in favour for the approval bar, given the opposition as it stands. */
function approvalShortfall(rules: VotingRules, support: VotingSupport): bigint {
  const decided = support.yes + support.no;
  // yes * 10000 >= approvalBps * (yes + no)  <=>  yes * (10000 - bps) >= bps * no
  const room = 10_000n - rules.approvalBps;
  let needed =
    room === 0n
      ? support.no + 1n
      : (rules.approvalBps * support.no + room - 1n) / room;
  if (decided === 0n && needed < 1n) needed = 1n;
  if (needed <= support.no) needed = support.no + 1n;
  return needed > support.yes ? needed - support.yes : 0n;
}
/** What is still missing, in order. Opposition counts at once; support has to hold. */
export function votingRuleWatch(
  rules: VotingRules,
  support: VotingSupport,
  now: bigint,
  /** How Shares are written in the sentence; the default shows them exactly, a screen may group the digits. */
  format: (wei: bigint) => string = formatVotingShares,
): {
  status: "leading" | "holding" | "needs-votes" | "at-risk" | "expired";
  detail: string;
  /** What is still missing or what happens next, without the counts, for a screen that shows them already. */
  next: string;
} {
  if (now >= rules.expiresAt)
    return {
      status: "expired",
      detail: "Expired; allocations are available for other proposals.",
      next: "Expired; allocations are available for other proposals.",
    };
  const cast = support.yes + support.no + support.abstain;
  const moreQuorum = rules.quorum > cast ? rules.quorum - cast : 0n;
  const moreApproval = approvalShortfall(rules, support);
  const moreMin = rules.minYes > support.yes ? rules.minYes - support.yes : 0n;
  const missing = [moreQuorum, moreApproval, moreMin].reduce((a, b) =>
    a > b ? a : b,
  );
  const barsHold = missing === 0n;
  const earliest =
    support.qualifiedSince === 0n
      ? 0n
      : support.qualifiedSince + rules.hold > rules.reviewEndsAt
        ? support.qualifiedSince + rules.hold
        : rules.reviewEndsAt;
  const ready = barsHold && earliest !== 0n && now >= earliest;
  const lastDay = rules.expiresAt - now <= 12n * 3600n;
  const status = ready
    ? "leading"
    : barsHold
      ? "holding"
      : lastDay
        ? "at-risk"
        : "needs-votes";
  // Says which bar is short: too few Shares taking part, or too few backing it.
  const next = !barsHold
    ? `${format(missing)} more Shares need to ${missing === moreQuorum ? "take part" : "back it"}`
    : now < rules.reviewEndsAt &&
        earliest !== 0n &&
        earliest <= rules.reviewEndsAt
      ? "Enough votes; the review period is still running"
      : earliest !== 0n && now < earliest
        ? "Enough votes; they have to hold a little longer"
        : "Enough votes; it can run after the wait";
  return {
    status,
    detail: `In favour ${format(support.yes)} · Against ${format(support.no)} · Neutral ${format(support.abstain)} · ${next}. Votes can change until it is carried out.`,
    next: `${next}. Votes can change until it is carried out.`,
  };
}
/** The word a person reads for a watch status. */
export function votingStatusLabel(
  status: "leading" | "holding" | "needs-votes" | "at-risk" | "expired",
): string {
  switch (status) {
    case "leading":
      return "Ready to approve";
    case "holding":
      return "Holding";
    case "needs-votes":
      return "Needs more votes";
    case "at-risk":
      return "Running out of time";
    case "expired":
      return "Expired";
  }
}
