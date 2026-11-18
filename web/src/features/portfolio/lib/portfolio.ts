/**
 * Portfolio math: what you put in, what you got, and your share — in plain
 * numbers the page can show without anyone reading a contract.
 *
 * - **Backing.** Your bids in one raise, summed across your wallets: the
 *   money committed (a bid's `amountQ96` is the currency amount × 2^96), the
 *   tokens filled so far, and your share of everything the raise took in.
 *   Within one raise everyone's money went in during the same short window
 *   and stays in until they exit, so money share is the capital side of the
 *   participation weight there (`@creaton/core/org/participation.ts`).
 * - **Building.** Your accepted work in this community under the NIP-ORG
 *   review rule, as points and as your share of all accepted work, plus the
 *   claims still waiting for a reviewer.
 *
 * Pure and alias-free: `portfolio.test.mjs` drives it under `node --test`.
 */

import {
  acceptedWork,
  participationWeights,
  type ContributionEvent,
} from "@creaton/core/org/participation.ts";

const Q96 = 2n ** 96n;

/** The fields of an onchain bid the portfolio reads. */
export interface BidLike {
  amountQ96: bigint;
  tokensFilled: bigint;
  /** 0 while the bid is still in the auction. */
  exitedBlock: bigint;
}

export interface BackingSummary {
  /** Money committed, in the sale currency's base units. */
  committed: bigint;
  /** Tokens filled so far, in token base units. */
  tokens: bigint;
  /** Bids still in the auction. */
  open: number;
  /** Bids that have exited (refunded, or settled into tokens). */
  exited: number;
}

/** Sum your bids in one raise, across however many wallets placed them. */
export function summarizeBids(bids: readonly BidLike[]): BackingSummary {
  let committed = 0n;
  let tokens = 0n;
  let open = 0;
  let exited = 0;
  for (const bid of bids) {
    committed += bid.amountQ96 / Q96;
    tokens += bid.tokensFilled;
    if (bid.exitedBlock === 0n) open += 1;
    else exited += 1;
  }
  return { committed, tokens, open, exited };
}

/**
 * Your fraction (0–1) of what the raise took in, or null when the raise total
 * is unknown or zero. Capped at 1: a stale total must never show over 100%.
 */
export function raiseShare(
  committed: bigint,
  raised: bigint | null,
): number | null {
  if (raised === null || raised <= 0n) return null;
  if (committed <= 0n) return 0;
  // Basis points in bigint, then back to a float, so huge wei amounts keep
  // their precision.
  const bps = (committed * 10_000n) / raised;
  return Math.min(1, Number(bps) / 10_000);
}

export interface WorkStanding {
  /** Your accepted work points. */
  points: number;
  /** Everyone's accepted work points. */
  totalPoints: number;
  /** Your share of all accepted work (0–1), or null when nobody has any yet. */
  share: number | null;
  /** How many of your contributions were accepted. */
  accepted: number;
  /** Your claims with no accepting or rejecting review yet. */
  waiting: number;
}

/**
 * Your standing among everyone's accepted work in this community.
 * `isReviewer` answers whether a key holds human review authority.
 */
export function workStanding(
  records: readonly ContributionEvent[],
  isReviewer: (pubkey: string) => boolean,
  me: string,
  now: number,
): WorkStanding {
  const who = me.toLowerCase();
  const work = acceptedWork(records, isReviewer);
  const rows = participationWeights({ capital: [], work, now });
  const mine = rows.find((r) => r.who === who);
  const totalPoints = rows.reduce((sum, r) => sum + r.workPoints, 0);
  const acceptedActions = new Set(
    work.filter((w) => w.who === who).map((w) => w.action),
  );

  // Your claims: actions whose first claim-carrying record you signed.
  const firstByAction = new Map<string, { signer: string; at: number }>();
  for (const record of records) {
    const d = record.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    const seen = firstByAction.get(d);
    if (!seen || record.created_at < seen.at) {
      firstByAction.set(d, {
        signer: record.pubkey.toLowerCase(),
        at: record.created_at,
      });
    }
  }
  const decided = new Set<string>();
  for (const record of records) {
    const d = record.tags.find((t) => t[0] === "d")?.[1];
    const first = d ? firstByAction.get(d) : undefined;
    if (!d || !first || record.pubkey.toLowerCase() === first.signer) continue;
    if (!isReviewer(record.pubkey.toLowerCase())) continue;
    try {
      const status = (JSON.parse(record.content) as { reviewStatus?: unknown })
        .reviewStatus;
      if (status === "accepted" || status === "rejected") decided.add(d);
    } catch {
      // Unreadable review content decides nothing.
    }
  }
  let waiting = 0;
  for (const [d, first] of firstByAction) {
    if (first.signer === who && !decided.has(d)) waiting += 1;
  }

  return {
    points: mine?.workPoints ?? 0,
    totalPoints,
    share: totalPoints > 0 ? (mine?.workPoints ?? 0) / totalPoints : null,
    accepted: acceptedActions.size,
    waiting,
  };
}

/** "12.5%" / "<0.1%" / "0%" — a share for people, not a float. */
export function formatShare(share: number | null): string {
  if (share === null) return "—";
  if (share === 0) return "0%";
  const pct = share * 100;
  if (pct < 0.1) return "<0.1%";
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}
