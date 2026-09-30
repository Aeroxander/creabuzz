/**
 * The quorum watch (agentic-governance A5): turn-out risk made legible —
 * the toil agents should absorb. Pure model here; the badge renders it on
 * the proposal cards and an agent nudge is a NIP-ER reminder event
 * (`nudgeReminderParts`).
 *
 * Honest scope: the two VISIBLE gates are computed here — the FOR>AGAINST
 * margin and the `minYes` floor (majeur's tally gates). The dynamic bps
 * quorum is "vs snapshot supply", which only the DAO itself can adjudicate
 * at tally time — the copy says so rather than pretending to check it.
 */

export interface Tallies {
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
}

export type WatchStatus =
  | "leading" // the visible gates are met while voting is open
  | "needs-votes" // short of the visible gates, time remains
  | "at-risk" // short AND the TTL clock is in its last quarter
  | "expired"; // TTL passed while short

export interface WatchState {
  status: WatchStatus;
  /** Votes still needed to meet the visible gates (0 when leading). */
  votesNeeded: bigint;
  /** Seconds left on the proposal TTL (0 once expired). */
  secondsLeft: bigint;
  /** The plain-language line the badge renders verbatim. */
  detail: string;
}

/**
 * Compute the watch. `minYes` is majeur's absolute FOR floor; the margin
 * gate is "FOR must beat AGAINST". `ttlEndsAt`/`now` are unix seconds
 * (the record's timestamp + the onchain TTL is the deadline source).
 */
export function quorumWatch(input: {
  tallies: Tallies;
  minYes: bigint | null;
  ttlEndsAt: bigint | null;
  /** The proposal's timestamp (the record's `createdAt`, unix seconds). */
  createdAt: bigint;
  now: bigint;
}): WatchState {
  const { tallies, minYes, ttlEndsAt, createdAt, now } = input;
  // Margin gate: FOR must beat AGAINST -> need against + 1 votes of FOR.
  const marginGate =
    tallies.againstVotes + 1n > tallies.forVotes
      ? tallies.againstVotes + 1n - tallies.forVotes
      : 0n;
  // Floor gate: the absolute minYes FOR count.
  const floorGate =
    minYes !== null && minYes > tallies.forVotes
      ? minYes - tallies.forVotes
      : 0n;
  const votesNeeded = marginGate > floorGate ? marginGate : floorGate;

  const secondsLeft =
    ttlEndsAt !== null && ttlEndsAt > now ? ttlEndsAt - now : 0n;
  const expired = ttlEndsAt !== null && now >= ttlEndsAt;
  const ttlLen =
    ttlEndsAt !== null && ttlEndsAt > createdAt ? ttlEndsAt - createdAt : 0n;

  let status: WatchStatus;
  if (votesNeeded === 0n) {
    status = "leading";
  } else if (expired) {
    status = "expired";
  } else if (ttlLen > 0n && secondsLeft * 4n <= ttlLen) {
    // Short of the visible gates AND in the TTL's last quarter.
    status = "at-risk";
  } else {
    status = "needs-votes";
  }

  const detail = expired
    ? votesNeeded === 0n
      ? "TTL passed — in the executable window"
      : `TTL passed ${votesNeeded} vote(s) short — defeated unless extended`
    : votesNeeded === 0n
      ? "Visible gates met — leads FOR>AGAINST and clears the minYes floor"
      : `${votesNeeded} more FOR vote(s) needed · ${formatLeft(secondsLeft)} left`;

  return { status, votesNeeded, secondsLeft, detail };
}

/** "4d 3h" / "5h 12m" / "9m" — the badge's compact clock. */
function formatLeft(seconds: bigint): string {
  const s = Number(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * The A5 delivery: an agent-authored NIP-ER reminder (`KIND_EVENT_REMINDER`)
 * nudging the channel about quorum risk — with explicit agent identity (the
 * author IS the identity). Tags follow `validate_event_reminder`: exactly one
 * non-empty `d`, optional `not_before` + `expiration`.
 */
export function nudgeReminderParts(input: {
  /** Stable reminder id (`d`) — e.g. `quorum:<launchId>:<proposal>`. */
  d: string;
  title: string;
  body: string;
  /** Fire at (unix seconds) — usually "now" for a nudge. */
  notBefore: string;
  /** Auto-expire at the TTL (unix seconds as a decimal string). */
  expiration?: string;
}): { extraTags: string[][]; content: string } {
  const tags: string[][] = [
    ["d", input.d],
    ["not_before", input.notBefore],
  ];
  if (input.expiration !== undefined)
    tags.push(["expiration", input.expiration]);
  return {
    extraTags: tags,
    content: `${input.title}\n\n${input.body}`,
  };
}

/** `tallies(id)` return decode (three uint256 words: FOR, AGAINST, ABSTAIN). */
export function decodeTallies(returnData: string): Tallies | null {
  const hex = returnData.trim().replace(/^0x/, "");
  if (hex.length < 64 * 3) return null;
  return {
    forVotes: BigInt(`0x${hex.slice(0, 64)}`),
    againstVotes: BigInt(`0x${hex.slice(64, 128)}`),
    abstainVotes: BigInt(`0x${hex.slice(128, 192)}`),
  };
}
