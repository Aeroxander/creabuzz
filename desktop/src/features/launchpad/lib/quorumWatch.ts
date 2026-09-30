/**
 * The quorum watch (agentic-governance A5), desktop parity with web's
 * `lib/quorum-watch.ts`: turn-out risk made legible. Pure model here; the
 * proposals panel renders it and an agent nudge is a NIP-ER reminder event.
 *
 * Honest scope: the two VISIBLE gates — the FOR>AGAINST margin and the
 * `minYes` floor — are computed here; the dynamic bps quorum ("vs snapshot
 * supply") is adjudicated by the DAO at tally time and the copy says so.
 */

export interface Tallies {
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
}

export type WatchStatus = "leading" | "needs-votes" | "at-risk" | "expired";

export interface WatchState {
  status: WatchStatus;
  votesNeeded: bigint;
  secondsLeft: bigint;
  detail: string;
}

export function quorumWatch(input: {
  tallies: Tallies;
  minYes: bigint | null;
  ttlEndsAt: bigint | null;
  /** The proposal's timestamp (the record's `createdAt`, unix seconds). */
  createdAt: bigint;
  now: bigint;
}): WatchState {
  const { tallies, minYes, ttlEndsAt, createdAt, now } = input;
  const marginGate =
    tallies.againstVotes + 1n > tallies.forVotes
      ? tallies.againstVotes + 1n - tallies.forVotes
      : 0n;
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

function formatLeft(seconds: bigint): string {
  const s = Number(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
