/**
 * The decision-routing view model (`docs/agentic-governance-design.md`
 * sections 0 and 2) — what a proposal card must make legible: WHICH
 * MECHANISM decided this, WHO held what authority, WHERE the receipts are.
 * Pure routing/copy assembly here; the chain reads live in `fetchProposalStates`
 * over the `../chain` `ethCall` seam. Vote mechanics are `vote-tx.ts`.
 */

// Extension included on purpose: this module is driven by
// `governance-view.test.mjs`, which does not resolve extensionless specifiers.
import { ethCall } from "../chain.ts";
import {
  encodeStateView,
  PROPOSAL_STATES,
  type ProposalIntent,
} from "./vote-tx.ts";

export type ProposalKind = "plain" | "futarchy-budget" | "signal";

export interface GovernanceRoute {
  /** The D6-style mechanism chip — the first litmus fact. */
  mechanism: string;
  /** Whether a ballot belongs on this card at all (D1: signals never get one). */
  ballot: boolean;
  /** The plain-language why-this-mechanism line. */
  rationale: string;
}

/**
 * The routing map (D1): each proposal kind gets its native mechanism. The
 * map is the spine — a generic ballot over everything is exactly the
 * "democracy theater" the design rejects.
 */
export function governanceRoute(kind: ProposalKind): GovernanceRoute {
  switch (kind) {
    case "signal":
      return {
        mechanism: "Deliberation",
        ballot: false,
        rationale:
          "Sentiment aggregates through discussion, not a vote. Discuss in the channel or the linked issue.",
      };
    case "futarchy-budget":
      return {
        mechanism: "Futarchy · budget",
        ballot: true,
        rationale:
          "Budget and subDAO allocation resolve through decision markets (read-only until markets land).",
      };
    case "plain":
      return {
        mechanism: "Token vote",
        ballot: true,
        rationale:
          "General matters settle by recorded vote: N-1 snapshot, quorum, FOR must beat AGAINST.",
      };
  }
}

export interface QuorumParams {
  quorumBps?: number | null;
  /** majeur's absolute quorum — the number when `quorumBps` is 0 (off). */
  quorumAbsolute?: number | null;
  minYes?: number | null;
  proposalTtl?: string | null;
  /** Raw seconds behind `proposalTtl` (the A5 watch's clock input). */
  proposalTtlSeconds?: bigint | null;
  timelockDelay?: string | null;
}

/**
 * D6: the rules in one plain-language line, before anyone votes. Unknown
 * values say "per DAO config" — never invented numbers.
 */
export function quorumSummary(params: QuorumParams = {}): string {
  let quorum: string;
  if (params.quorumBps != null && params.quorumBps > 0) {
    quorum = `quorum ${params.quorumBps / 100}% of snapshot supply`;
  } else if (params.quorumAbsolute != null && params.quorumAbsolute > 0) {
    quorum = `quorum ${params.quorumAbsolute} absolute`;
  } else {
    quorum = "quorum per DAO config";
  }
  const minYes =
    params.minYes != null && params.minYes > 0
      ? `minYes ${params.minYes}`
      : "minYes per DAO config";
  const ttl =
    params.proposalTtl != null
      ? `TTL ${params.proposalTtl}`
      : "TTL per DAO config";
  const lock =
    params.timelockDelay != null
      ? `timelock ${params.timelockDelay}`
      : "timelock per DAO config";
  return `N-1 snapshot · ${quorum} · FOR must beat AGAINST · ${minYes} · ${ttl} · ${lock}`;
}

/** D8: the record-only fallback — no onchain binding, no invented actions. */
export const RECORD_ONLY_COPY =
  "Record-only: this proposal is tracked here, but its actions are carried out by the treasury, following the recorded decision.";

/** The second litmus fact: who acted, and under what authority (D5). */
export function authorityLine(author: string, grant?: string | null): string {
  const who = `Proposed by ${author}`;
  return grant
    ? `${who} · under grant ${grant}`
    : `${who} · no recorded delegation`;
}

/** The third litmus fact: where the receipts are (D4). */
export const RECEIPTS_COPY =
  "Receipts: the proposal, each vote and the execution are recorded here, each linked to its transaction.";

/** Decode `state(id)`'s uint256 word into majeur's label. */
export function decodeProposalState(word: bigint | number): string {
  const index = Number(word);
  return PROPOSAL_STATES[index] ?? `Unknown(${index})`;
}

/** `state(id)` reads for a batch of proposals (the action gates). */
export async function fetchProposalStates(input: {
  endpoint: string;
  dao: string;
  ids: readonly string[];
}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of input.ids) {
    const raw = await ethCall(input.endpoint, input.dao, encodeStateView(id));
    out[id] = decodeProposalState(BigInt(raw));
  }
  return out;
}

export type { ProposalIntent };
