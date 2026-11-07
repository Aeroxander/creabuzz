/**
 * Agent liveness for org seats (docs/paperclip-ux-reference.md §2.1 "liveness
 * before numbers").
 *
 * Two relay sources tell us an agent seat was recently alive:
 *
 * - kind:44010 capability announcements — refreshed periodically, and the
 *   event author IS the agent identity (same seam the web fleet roster reads).
 * - kind:44200 turn metrics — one per completed turn, addressed to the
 *   budgeted subject via a `p` tag (see lib/budgetConsumption.ts).
 *
 * For each seat pubkey we keep the NEWEST signal of either kind and map its
 * age onto the Paperclip three-tier semantics: live (< 5 min), waiting /
 * degraded (< 60 min), gone (older, or never seen). Thresholds are constants
 * so every org surface (canvas cards, list rows, dashboard) shares one
 * vocabulary.
 *
 * Pure logic only: the fetch lives in ../hooks (useAgentLivenessQuery), the
 * derivation here is unit-testable without a relay.
 */
import {
  KIND_AGENT_CAPABILITIES,
  KIND_AGENT_TURN_METRIC,
} from "@/shared/constants/kinds";

/** A seat signaled within this window is live. */
export const AGENT_LIVE_MAX_SECONDS = 5 * 60;
/** A seat signaled within this window is waiting/degraded; older is gone. */
export const AGENT_WAITING_MAX_SECONDS = 60 * 60;

/**
 * Bounded read per kind. Heartbeat-style events flood history, so the fetch
 * never asks for more than this; a truncated page still contains the newest
 * signals (relays return events in ascending created_at, and the derivation
 * is honest about "no signal seen" rather than inventing one).
 */
export const LIVENESS_FETCH_LIMIT = 200;

export type AgentLivenessStatus = "live" | "waiting" | "gone";

export type AgentLiveness = {
  status: AgentLivenessStatus;
  /** Newest signal seen for the seat (unix seconds); null when never seen. */
  lastSeenAt: number | null;
};

/** Structural slice of a relay event — keeps the derivation relay-agnostic. */
export type LivenessEventLike = {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: ReadonlyArray<readonly string[]>;
};

/** Paperclip semantics: live < 5 min, waiting < 60 min, gone otherwise. */
export function livenessStatus(
  lastSeenSeconds: number | null,
  nowSeconds: number,
): AgentLivenessStatus {
  if (lastSeenSeconds === null) return "gone";
  const ageSeconds = nowSeconds - lastSeenSeconds;
  if (ageSeconds < AGENT_LIVE_MAX_SECONDS) return "live";
  if (ageSeconds < AGENT_WAITING_MAX_SECONDS) return "waiting";
  return "gone";
}

/**
 * Newest signal per seat across both kinds. kind:44010 signals attach to the
 * event author (the agent itself); kind:44200 signals attach to every `p`
 * subject. Keys are lowercase so callers can look seats up verbatim.
 * Malformed rows are skipped, never guessed.
 */
export function newestSeenPerSeat(
  events: ReadonlyArray<LivenessEventLike>,
  seatPubkeys: ReadonlyArray<string>,
  nowSeconds: number,
): ReadonlyMap<string, AgentLiveness> {
  const seats = new Set(
    seatPubkeys.map((pubkey) => pubkey.trim().toLowerCase()).filter(Boolean),
  );
  const newest = new Map<string, number>();
  const bump = (seat: string, createdAt: number) => {
    if (
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      (newest.get(seat) ?? Number.NEGATIVE_INFINITY) >= createdAt
    ) {
      return;
    }
    newest.set(seat, createdAt);
  };

  for (const event of events) {
    if (!event || typeof event.created_at !== "number") continue;
    if (event.kind === KIND_AGENT_CAPABILITIES) {
      const author = typeof event.pubkey === "string" ? event.pubkey : "";
      const seat = author.trim().toLowerCase();
      if (seats.has(seat)) bump(seat, event.created_at);
    } else if (event.kind === KIND_AGENT_TURN_METRIC) {
      for (const tag of event.tags ?? []) {
        if (!Array.isArray(tag) || tag[0] !== "p") continue;
        const subject = typeof tag[1] === "string" ? tag[1] : "";
        const seat = subject.trim().toLowerCase();
        if (seats.has(seat)) bump(seat, event.created_at);
      }
    }
  }

  const result = new Map<string, AgentLiveness>();
  for (const seat of seats) {
    const lastSeenAt = newest.get(seat) ?? null;
    result.set(seat, {
      status: livenessStatus(lastSeenAt, nowSeconds),
      lastSeenAt,
    });
  }
  return result;
}

const STATUS_RANK: Record<AgentLivenessStatus, number> = {
  live: 2,
  waiting: 1,
  gone: 0,
};

/**
 * Aggregate status for a set of seats, best-first: a node with any live seat
 * is live; otherwise waiting wins over gone. Returns null when the set is
 * empty (human-only nodes show no dot at all).
 */
export function bestSeatStatus(
  statuses: ReadonlyArray<AgentLivenessStatus | undefined>,
): AgentLivenessStatus | null {
  let best: AgentLivenessStatus | null = null;
  for (const status of statuses) {
    if (!status) continue;
    if (best === null || STATUS_RANK[status] > STATUS_RANK[best]) {
      best = status;
      if (status === "live") break;
    }
  }
  return best;
}

/** Unique seat pubkeys across org nodes, lowercased, stable order. */
export function collectAgentSeats(
  nodes: ReadonlyArray<{ agentSeats: ReadonlyArray<string> }>,
): string[] {
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const seat of node.agentSeats ?? []) {
      const seatLower = seat.trim().toLowerCase();
      if (seatLower) seen.add(seatLower);
    }
  }
  return [...seen];
}
