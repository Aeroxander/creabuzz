/**
 * The decision-routing map (`docs/agentic-governance-design.md` §2, D1) as
 * pure display logic behind `ui/LaunchProposalsPanel.tsx` — unit-tested in
 * `decisionRouting.test.mjs`.
 *
 * The spine: a 47004 proposal's `kind` selects its NATIVE mechanism. A
 * generic yes/no across decision types is democracy theater (D1), so:
 *
 * - `signal` -> deliberation (channel / linked issue), **no ballot**;
 * - `plain` -> the majeur ballot (For/Against/Abstain + the lifecycle);
 * - `futarchy-budget` -> read-only market note (markets land later; D7 keeps
 *   futarchy scoped to budget & subDAO allocation only).
 *
 * The panel's litmus test (§0) is assembled from what this module returns:
 * every card shows which mechanism decided this, who held authority (D5),
 * and where the receipts are — the kind:47005 proposal/vote/execute mirrors
 * (D4) — with no tooltip. D8's record-only fallback is the exact copy a
 * card without an onchain binding renders instead of actions.
 */

import type {
  LaunchProposal,
  LaunchReceipt,
  ProposalKind,
} from "@/features/launchpad/launchpadModels";
import type {
  ProposalAction,
  ProposalState,
} from "@/features/launchpad/lib/voteTx";
import { truncatePubkey } from "@/shared/lib/pubkey";

// ---------------------------------------------------------------------------
// D1 — the routing map
// ---------------------------------------------------------------------------

/** One row of the §2 decision-routing map, rendered on the card. */
export interface DecisionRoute {
  kind: ProposalKind;
  /** Short mechanism name — litmus fact 1, visible on every card. */
  mechanism: string;
  /** Why this mechanism fits this decision (D1's information-structure rule). */
  why: string;
  /** Whether the route carries a ballot at all (anti-theater: signal = false). */
  ballot: boolean;
  /** The card's static route note (deliberation / market copy). */
  note: string;
}

/** The routing map for the proposal kinds the 47004 record distinguishes. */
export function routeDecision(kind: ProposalKind): DecisionRoute {
  switch (kind) {
    case "signal":
      return {
        kind,
        mechanism: "Deliberation",
        why: "Sentiment and roadmap taste are distributed knowledge. Discussion aggregates it; a ballot misprices it.",
        ballot: false,
        note: "Discuss in channel / linked issue. The outcome is a wiki standup summary, not a tally. No ballot: a vote would misprice distributed sentiment.",
      };
    default:
      return {
        kind,
        mechanism: "Shares vote",
        why: "Movable Shares allocations with free opposition, requirements frozen when the proposal opens, a minimum review, support that has to hold, and an execution delay.",
        ballot: true,
        note: "Shares alone allocate support. Loot retains economic rights. Every executable proposal uses this policy.",
      };
  }
}

// ---------------------------------------------------------------------------
// Action routing (D1 routing map x majeur state gating x D8 binding)
// ---------------------------------------------------------------------------

/** The panel's onchain actions, in lifecycle order. */
export type { ProposalAction } from "@/features/launchpad/lib/voteTx";

/** Button labels for {@link renderedActions} output, in lifecycle order. */
export const PROPOSAL_ACTION_LABELS: Record<string, string> = {
  open: "Open (fix N-1 snapshot)",
  "vote-for": "For",
  "vote-against": "Against",
  "vote-abstain": "Abstain",
  queue: "Queue (start timelock)",
  execute: "Execute / start timelock",
};

/**
 * Which actions a card renders right now. D1 routes by kind (a `signal`
 * never gets a ballot even when onchain-bound), the `state(id)` read gates
 * the lifecycle, and without an onchain binding nothing is composable —
 * the card falls back to {@link RECORD_ONLY_COPY} (D8).
 */
export function renderedActions(input: {
  kind: ProposalKind;
  /** The onchain `state(id)` label, or null when not bound or unread. */
  state: ProposalState | null;
  /** True when the record carries a usable onchain binding (id + DAO). */
  bound: boolean;
  /** True when the record carries the operation `executeByVotes` needs. */
  hasOperation: boolean;
}): readonly ProposalAction[] {
  if (!input.bound || !input.state) return [];
  // All executable proposals use the same Shares policy; signals remain discussion.
  if (!routeDecision(input.kind).ballot) return [];
  switch (input.state) {
    case "Unopened":
      // First votes auto-open; the explicit open fixes the N-1 snapshot first.
      if (input.hasOperation) return ["open"];
      return ["open", "vote-for", "vote-against", "vote-abstain"];
    case "Active":
      return ["vote-for", "vote-against", "vote-abstain"];
    case "Succeeded":
      return [
        "vote-for",
        "vote-against",
        "vote-abstain",
        ...(input.hasOperation ? ["execute" as const] : ["queue" as const]),
      ];
    case "Queued":
      return ["vote-for", "vote-against", "vote-abstain"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// D8 — the mirror-only fallback
// ---------------------------------------------------------------------------

/**
 * The record-only fallback copy, verbatim (D8): every action degrades
 * honestly to a treasury action against the recorded decision when the
 * launch is not wired onchain.
 */
export const RECORD_ONLY_COPY =
  "Record-only: actions run as a treasury action against the recorded decision.";

// ---------------------------------------------------------------------------
// D5 — who acted
// ---------------------------------------------------------------------------

/**
 * The authority line (D5): the proposer plus grant provenance when the
 * record carries it, and an honest fallback when it does not.
 */
export function authorityLine(input: {
  proposer: string;
  grant?: string | null;
}): string {
  const proposer = truncatePubkey(input.proposer);
  if (input.grant) {
    return `Proposed by ${proposer} under delegation ${truncatePubkey(input.grant)}. It is a limited, revocable permission recorded with this proposal.`;
  }
  return `Proposed by ${proposer} under their own key. No delegation grant is recorded on this record.`;
}

// ---------------------------------------------------------------------------
// D4 — where the receipts are (the kind:47005 mirrors)
// ---------------------------------------------------------------------------

/** The receipt vocabulary this panel reads and writes (D4, §5). */
export const RECEIPTS_VOCABULARY =
  "the proposal, each vote and the execution, each recorded with its transaction";

/** The 47005 tables the governance lifecycle emits. */
export const GOV_RECEIPT_TABLES = ["proposal", "vote", "execute"] as const;

/**
 * The mirror receipts recorded for one proposal: the §5 tags (`proposal` =
 * record id, `onchain` = proposalId) or the payload's same fields link a
 * mirror to its proposal.
 */
export function proposalReceipts(
  receipts: readonly LaunchReceipt[],
  proposal: Pick<LaunchProposal, "id" | "proposalId">,
): readonly LaunchReceipt[] {
  return receipts.filter((receipt) => {
    if (!(GOV_RECEIPT_TABLES as readonly string[]).includes(receipt.table)) {
      return false;
    }
    const tagged =
      receipt.proposal === proposal.id ||
      (proposal.proposalId !== null && receipt.onchain === proposal.proposalId);
    const inPayload =
      receipt.payload.proposal === proposal.id ||
      (proposal.proposalId !== null &&
        receipt.payload.onchain === proposal.proposalId);
    return tagged || inPayload;
  });
}

/**
 * Compose one kind:47005 governance mirror (D4, §5) for a landed action:
 * the closed-table vocabulary (`proposal` / `vote` / `execute`), the §5 tags
 * (`proposal` = record id, `onchain` = proposalId, the `vote` word
 * `for|against|abstain`, `tx`), and the content payload
 * {@link proposalReceipts} links back. `queue` records into the `execute`
 * table with an `action: "queue"` stage marker — the lifecycle's execution
 * phase, with the exact step spelled out.
 */
export function governanceReceiptMirror(input: {
  action: ProposalAction;
  recordId: string;
  proposalId: string | null;
  txHash: string;
}): { extraTags: string[][]; content: Record<string, unknown> } {
  const table =
    input.action === "open"
      ? "proposal"
      : input.action === "queue" || input.action === "execute"
        ? "execute"
        : "vote";
  const vote =
    input.action === "vote-for"
      ? "for"
      : input.action === "vote-against"
        ? "against"
        : input.action === "vote-abstain"
          ? "abstain"
          : null;
  const stage =
    input.action === "queue" || input.action === "execute"
      ? input.action
      : null;
  const extraTags: string[][] = [
    ["kind", table],
    ["tx", input.txHash],
    ["proposal", input.recordId],
  ];
  if (input.proposalId) extraTags.push(["onchain", input.proposalId]);
  if (vote) extraTags.push(["vote", vote]);
  const content: Record<string, unknown> = {
    table,
    proposal: input.recordId,
    onchain: input.proposalId,
    tx: input.txHash,
  };
  if (vote) content.vote = vote;
  if (stage) content.action = stage;
  return { extraTags, content };
}

// ---------------------------------------------------------------------------
// Onchain binding (the D8 gate)
// ---------------------------------------------------------------------------

/** Where the DAO behind a proposal's actions was found — the UI states it. */
export interface ProposalDaoBinding {
  dao: string;
  source: "proposal-record" | "summon-receipt";
  /** The event/tx that carries the binding. */
  ref: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve the DAO a proposal's lifecycle runs against. The record's own
 * `onchain` binding wins (S0: `{chain, dao, proposalId}`, mirroring 37010's
 * pattern); the launch's NIP-LP `summon` receipt payload (`dao` field) is
 * the fallback — the same resolution web's `resolveDaoBinding` applies.
 */
export function resolveDaoBinding(
  proposal: Pick<LaunchProposal, "id" | "onchain">,
  receipts: readonly LaunchReceipt[],
): ProposalDaoBinding | null {
  const fromRecord = proposal.onchain?.dao;
  if (fromRecord && ADDRESS_RE.test(fromRecord)) {
    return {
      dao: fromRecord.toLowerCase(),
      source: "proposal-record",
      ref: proposal.id,
    };
  }
  let newest: ProposalDaoBinding | null = null;
  let newestAt = -1;
  for (const receipt of receipts) {
    if (receipt.table !== "summon") continue;
    const dao = receipt.payload.dao;
    if (typeof dao !== "string" || !ADDRESS_RE.test(dao)) continue;
    if (receipt.createdAt >= newestAt) {
      newestAt = receipt.createdAt;
      newest = {
        dao: dao.toLowerCase(),
        source: "summon-receipt",
        ref: receipt.tx,
      };
    }
  }
  return newest;
}
