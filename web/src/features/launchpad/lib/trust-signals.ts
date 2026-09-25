/**
 * Trust signals — the *outcome* side of the trust surface.
 *
 * `ProvenCommitmentsCard` states what a launch promises (the signed record +
 * chain checks); this module aggregates what the system already records, so
 * the trust page can show a track record instead of only declarations:
 *
 * 1. **Milestone verdicts + claims (kind 47005, tag `kind=verdict` /
 *    `kind=claim`)** — `docs/nips/NIP-LP.md:268-284` fixes the verdict word at
 *    the closed vocabulary `approve|reject` and requires every 47005 to carry
 *    the settlement `tx` tag (the relay refuses one without it:
 *    `crates/buzz-relay/src/handlers/ingest.rs`,
 *    `validate_launch_mirror_envelope`). Producers:
 *    `lib/milestone-receipt.ts` (web) and
 *    `crates/buzz-cli/src/commands/launchpad.rs:807-832`.
 *    Note: **47003 is the founder update** (`title`/`body`/`links` only —
 *    `web/src/shared/constants/kinds.ts:26`, `models.ts:parseLaunchUpdate`);
 *    the verdict vocabulary rides 47005, so that is what this aggregates.
 * 2. **Milestone receipts (kind 47005, `sweep`/`lock`/`ragequit`/…)** — the
 *    money-movement mirrors `fund-flow.ts` decodes. "Confirmed" here means
 *    exactly one thing: the `tx` tag matches `TX_HASH_RE` (the shape the
 *    relay validates); it is never a claim that the chain was re-read.
 * 3. **Contribution records (kind 37013)** — `docs/nips/NIP-ORG.md:107` and
 *    :373-399: resolution is `reviewStatus` on the *canonical* record (newest
 *    `created_at` per `d` tag wins, tie broken by lowest event id), and a
 *    reviewer republishes under their own key — so a disposition signed by
 *    someone other than the drafter is legible as a review, not an edit.
 * 4. **Approval outcomes (kinds 46030/46031)** —
 *    `crates/buzz-core/src/kind.rs:695-697`: grant/deny for a workflow
 *    approval request. A contribution inherits one **only** when the approval
 *    event actually names it (`e` tag = the record's event id, or `d` tag =
 *    the action id). Anything else stays an unlinked community outcome — an
 *    approval that does not name a record never counts as that record's
 *    resolution.
 *
 * Conventions this module keeps (org-money / fund-flow / TreasuryFlowsPanel):
 * - **Malformed payloads are counted, not dropped.** Every mirror that fails to
 *   read lands in an `unreadable` counter and the card shows it.
 * - **No signal says "no signal".** `emptyTrustRecord()` is all zeros and
 *   `trackRecordState` returns `"empty"`, so the UI renders
 *   `EMPTY_TRACK_RECORD_COPY` rather than a zero-filled history.
 * - **Every figure keeps its source.** `trackRecordDerivation` returns the
 *   rows the card renders, each with the kind + tag it came from, so the
 *   displayed breakdown *is* the derivation (`trust-signals.test.mjs` binds
 *   the rows to independently recomputed inputs).
 *
 * **No composite number, on purpose.** `trust-score.ts`'s `score` is an
 * operator-published value proven against a kind:37006 Merkle root (leaf =
 * `keccak256(abi.encode(member, score))`); a locally computed score could not
 * verify against that root while looking identical to one that does. There is
 * also no signed weighting that combines verdicts, receipts and contributions
 * into a rating. The plan's rule — "no fabricated numbers"
 * (`docs/next-gen-launchpad-plan.md` §B3) — therefore makes this deliverable a
 * structured record: counts + timeline + the derivation that produced them.
 */
import type { NostrEvent } from "@/shared/lib/nostr-client";
// Relative with the `.ts` extension: this module is driven by
// `trust-signals.test.mjs` under `node --test`, which does not resolve
// extensionless specifiers (the `models.ts` convention).
import {
  KIND_CONTRIBUTION_RECORD,
  KIND_LAUNCH_RECEIPT,
} from "../../../shared/constants/kinds.ts";
import type { LaunchReceipt } from "../models.ts";
import { EVIDENCE_HASH_RE, TX_HASH_RE } from "./milestone-receipt.ts";

/** Workflow approval outcomes — `crates/buzz-core/src/kind.rs:695-697`. */
export const KIND_APPROVAL_GRANT = 46030;
export const KIND_APPROVAL_DENY = 46031;

/** NIP-LP's closed verdict vocabulary (`docs/nips/NIP-LP.md:274-276`). */
export const VERDICT_WORDS = ["approve", "reject"] as const;
export type VerdictWord = (typeof VERDICT_WORDS)[number];

export function isVerdictWord(value: unknown): value is VerdictWord {
  return value === "approve" || value === "reject";
}

/** The empty-state copy, in one place so tests and UI cannot drift apart. */
export const EMPTY_TRACK_RECORD_COPY = "No verdicts or receipts yet.";

function payloadString(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const raw = payload[field];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// ---------------------------------------------------- launch outcomes ----

/** One readable `kind=verdict` mirror (47005). */
export interface VerdictSignal {
  claimId: string;
  verdict: VerdictWord;
  /** The verifier who signed it (their key, not a display name). */
  author: string;
  createdAt: number;
  /** Settlement tx as published; `txOk` says whether it is linkable. */
  tx: string;
  txOk: boolean;
  eventId: string;
}

/** One readable `kind=claim` mirror (47005). */
export interface ClaimSignal {
  claimId: string;
  evidenceHash: string | null;
  /** The evidence hash is 64 hex as `milestone-receipt.ts` requires. */
  evidenceOk: boolean;
  author: string;
  createdAt: number;
  tx: string;
  txOk: boolean;
  eventId: string;
}

/** Any other 47005 receipt word (sweep/lock/ragequit/summon/graduate/…). */
export interface SettlementSignal {
  table: string;
  author: string;
  createdAt: number;
  tx: string;
  txOk: boolean;
  eventId: string;
}

/** One milestone, paired: its claim mirror and every verdict on it. */
export interface MilestoneTimelineEntry {
  claimId: string;
  claim: ClaimSignal | null;
  /** Ascending by `createdAt`; each one names its author and tx. */
  verdicts: VerdictSignal[];
  /**
   * A claim plus at least one verdict, every mirror naming a well-formed tx —
   * the honest Nostr-side reading of "settled on-chain". The chain remains the
   * ledger; this is what the mirrors assert.
   */
  settled: boolean;
  /** Latest activity on this milestone (timeline sort key). */
  lastActivityAt: number;
}

export interface LaunchTrustCounts {
  approved: number;
  rejected: number;
  claims: number;
  settled: number;
  /** Every 47005 mirror read for this launch. */
  receiptsTotal: number;
  /** …whose `tx` tag matches `TX_HASH_RE`. */
  receiptsConfirmed: number;
  /** …whose `tx` tag does not (counted, not dropped). */
  receiptsMalformed: number;
  /** Non-milestone receipt words, by word. `other` = everything else. */
  byWord: { sweep: number; lock: number; ragequit: number; other: number };
}

export interface LaunchTrustUnreadable {
  /** `kind=verdict` mirrors without a claim id or a closed-vocabulary word. */
  verdicts: number;
  /** `kind=claim` mirrors without a claim id. */
  claims: number;
  total: number;
}

export interface LaunchTrustRecord {
  verdicts: VerdictSignal[];
  claims: ClaimSignal[];
  settlements: SettlementSignal[];
  timeline: MilestoneTimelineEntry[];
  counts: LaunchTrustCounts;
  unreadable: LaunchTrustUnreadable;
}

/** The all-zero record — an honest "nothing recorded", never fake history. */
export function emptyTrustRecord(): LaunchTrustRecord {
  return {
    verdicts: [],
    claims: [],
    settlements: [],
    timeline: [],
    counts: {
      approved: 0,
      rejected: 0,
      claims: 0,
      settled: 0,
      receiptsTotal: 0,
      receiptsConfirmed: 0,
      receiptsMalformed: 0,
      byWord: { sweep: 0, lock: 0, ragequit: 0, other: 0 },
    },
    unreadable: { verdicts: 0, claims: 0, total: 0 },
  };
}

/** `"empty"` → the card renders `EMPTY_TRACK_RECORD_COPY`, not counts. */
export function trackRecordState(
  record: LaunchTrustRecord,
): "empty" | "recorded" {
  return record.counts.receiptsTotal > 0 ? "recorded" : "empty";
}

/**
 * Aggregate one launch's 47005 mirrors into verdicts, claims, receipts and a
 * per-milestone timeline. Malformed mirrors are counted in `unreadable`
 * (payloads) or `receiptsMalformed` (tx tag) — never silently dropped.
 */
export function aggregateLaunchTrustSignals(
  receipts: readonly LaunchReceipt[],
): LaunchTrustRecord {
  const record = emptyTrustRecord();
  const verdicts: VerdictSignal[] = [];
  const claims: ClaimSignal[] = [];
  const settlements: SettlementSignal[] = [];
  let unreadableVerdicts = 0;
  let unreadableClaims = 0;

  for (const receipt of receipts) {
    const txOk = TX_HASH_RE.test(receipt.tx);
    record.counts.receiptsTotal += 1;
    if (txOk) record.counts.receiptsConfirmed += 1;
    else record.counts.receiptsMalformed += 1;

    if (receipt.table === "verdict") {
      const claimId = payloadString(receipt.payload, "claim");
      const word = receipt.payload.verdict;
      // A verdict that cannot name its milestone, or that steps outside the
      // closed vocabulary, is counted — it is evidence of something unreadable,
      // not evidence of nothing.
      if (!claimId || !isVerdictWord(word)) {
        unreadableVerdicts += 1;
        continue;
      }
      verdicts.push({
        claimId,
        verdict: word,
        author: receipt.author,
        createdAt: receipt.createdAt,
        tx: receipt.tx,
        txOk,
        eventId: receipt.id,
      });
      continue;
    }

    if (receipt.table === "claim") {
      const claimId = payloadString(receipt.payload, "claim");
      if (!claimId) {
        unreadableClaims += 1;
        continue;
      }
      const evidenceHash = payloadString(receipt.payload, "evidenceHash");
      claims.push({
        claimId,
        evidenceHash,
        evidenceOk:
          evidenceHash !== null && EVIDENCE_HASH_RE.test(evidenceHash),
        author: receipt.author,
        createdAt: receipt.createdAt,
        tx: receipt.tx,
        txOk,
        eventId: receipt.id,
      });
      continue;
    }

    settlements.push({
      table: receipt.table,
      author: receipt.author,
      createdAt: receipt.createdAt,
      tx: receipt.tx,
      txOk,
      eventId: receipt.id,
    });
    if (receipt.table === "sweep") record.counts.byWord.sweep += 1;
    else if (receipt.table === "lock") record.counts.byWord.lock += 1;
    else if (receipt.table === "ragequit") record.counts.byWord.ragequit += 1;
    else record.counts.byWord.other += 1;
  }

  verdicts.sort((a, b) => a.createdAt - b.createdAt);
  claims.sort((a, b) => a.createdAt - b.createdAt);
  settlements.sort((a, b) => a.createdAt - b.createdAt);

  record.verdicts = verdicts;
  record.claims = claims;
  record.settlements = settlements;
  record.unreadable = {
    verdicts: unreadableVerdicts,
    claims: unreadableClaims,
    total: unreadableVerdicts + unreadableClaims,
  };
  record.counts.approved = verdicts.filter(
    (v) => v.verdict === "approve",
  ).length;
  record.counts.rejected = verdicts.filter(
    (v) => v.verdict === "reject",
  ).length;
  record.counts.claims = claims.length;
  record.timeline = buildTimeline(claims, verdicts);
  record.counts.settled = record.timeline.filter((e) => e.settled).length;
  return record;
}

/**
 * Pair verdicts with their claim by milestone id — the pairing key is the
 * mirror's own `claim` payload field, and a verdict whose claim was never
 * mirrored still appears (under its claim id, with no claim row) rather than
 * being dropped. Newest activity first, for reading.
 */
function buildTimeline(
  claims: readonly ClaimSignal[],
  verdicts: readonly VerdictSignal[],
): MilestoneTimelineEntry[] {
  const byId = new Map<string, MilestoneTimelineEntry>();
  const ensure = (claimId: string): MilestoneTimelineEntry => {
    const found = byId.get(claimId);
    if (found) return found;
    const entry: MilestoneTimelineEntry = {
      claimId,
      claim: null,
      verdicts: [],
      settled: false,
      lastActivityAt: 0,
    };
    byId.set(claimId, entry);
    return entry;
  };
  for (const claim of claims) ensure(claim.claimId).claim = claim;
  for (const verdict of verdicts)
    ensure(verdict.claimId).verdicts.push(verdict);
  for (const entry of byId.values()) {
    entry.verdicts.sort((a, b) => a.createdAt - b.createdAt);
    const mirrors = [entry.claim, ...entry.verdicts].filter(
      (m): m is ClaimSignal | VerdictSignal => m !== null,
    );
    entry.settled =
      entry.claim !== null &&
      entry.verdicts.length > 0 &&
      mirrors.every((m) => m.txOk);
    entry.lastActivityAt = mirrors.reduce(
      (max, m) => Math.max(max, m.createdAt),
      0,
    );
  }
  return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

// --------------------------------------------------------- derivation ----

/** One row of the breakdown the trust card renders. */
export interface DerivationRow {
  key: string;
  label: string;
  value: number;
  /** Where the number came from: kind + tag, so the source travels with it. */
  source: string;
}

const MILESTONE_SOURCE = `kind ${KIND_LAUNCH_RECEIPT} · tag kind=verdict · verdict=approve`;
const REJECT_SOURCE = `kind ${KIND_LAUNCH_RECEIPT} · tag kind=verdict · verdict=reject`;
const CLAIM_SOURCE = `kind ${KIND_LAUNCH_RECEIPT} · tag kind=claim`;
const TX_SOURCE = `kind ${KIND_LAUNCH_RECEIPT} · tag tx`;
const UNREADABLE_SOURCE = `${KIND_LAUNCH_RECEIPT} payload — counted, not dropped`;

/**
 * The exact rows the card renders, in order. `trust-signals.test.mjs` asserts
 * each value against inputs recomputed from the raw mirrors, so a breakdown
 * that stops matching its inputs fails the suite.
 */
export function trackRecordDerivation(
  record: LaunchTrustRecord,
): DerivationRow[] {
  return [
    {
      key: "approved",
      label: "Milestones approved",
      value: record.counts.approved,
      source: MILESTONE_SOURCE,
    },
    {
      key: "rejected",
      label: "Milestones rejected",
      value: record.counts.rejected,
      source: REJECT_SOURCE,
    },
    {
      key: "claims",
      label: "Milestone claims recorded",
      value: record.counts.claims,
      source: CLAIM_SOURCE,
    },
    {
      key: "settled",
      label: "Milestones settled (claim + verdict, well-formed tx)",
      value: record.counts.settled,
      source: `${TX_SOURCE} on every mirror of the milestone`,
    },
    {
      key: "receipts-confirmed",
      label: "Receipts with a well-formed settlement tx",
      value: record.counts.receiptsConfirmed,
      source: TX_SOURCE,
    },
    {
      key: "receipts-malformed",
      label: "Receipts with a malformed tx",
      value: record.counts.receiptsMalformed,
      source: `${UNREADABLE_SOURCE} (tx tag)`,
    },
    {
      key: "unreadable-verdicts",
      label: "Verdict mirrors unreadable",
      value: record.unreadable.verdicts,
      source: UNREADABLE_SOURCE,
    },
    {
      key: "unreadable-claims",
      label: "Claim mirrors unreadable",
      value: record.unreadable.claims,
      source: UNREADABLE_SOURCE,
    },
    {
      key: "word-sweep",
      label: "Sweep receipts",
      value: record.counts.byWord.sweep,
      source: `kind ${KIND_LAUNCH_RECEIPT} · tag kind=sweep`,
    },
    {
      key: "word-lock",
      label: "Lock receipts",
      value: record.counts.byWord.lock,
      source: `kind ${KIND_LAUNCH_RECEIPT} · tag kind=lock`,
    },
    {
      key: "word-ragequit",
      label: "Ragequit receipts",
      value: record.counts.byWord.ragequit,
      source: `kind ${KIND_LAUNCH_RECEIPT} · tag kind=ragequit`,
    },
    {
      key: "word-other",
      label: "Other receipt words",
      value: record.counts.byWord.other,
      source: `kind ${KIND_LAUNCH_RECEIPT} · other tag kind values`,
    },
  ];
}

// -------------------------------------------------- community outcomes ----

/** NIP-ORG's review vocabulary (`docs/nips/NIP-ORG.md:337-339,373-376`). */
export type ReviewStatus = "pending" | "accepted" | "rejected" | "appealed";

const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "appealed",
];

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return (
    typeof value === "string" &&
    (REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

/** One canonical contribution record (kind 37013), plus its resolution. */
export interface ContributionSignal {
  eventId: string;
  /** The action id (`d` tag); null when the record published without one. */
  actionId: string | null;
  /** The canonical record's signer. */
  author: string;
  createdAt: number;
  action: string;
  reviewStatus: ReviewStatus | "unknown";
  /** Set when a key other than the drafter published the canonical record. */
  reviewedBy: string | null;
  /** A 46030/46031 approval that names this record — otherwise null. */
  approval: "granted" | "denied" | null;
}

export interface CommunityTrustCounts {
  accepted: number;
  rejected: number;
  appealed: number;
  pending: number;
  unknown: number;
  /** 37013 versions replaced by a newer one for the same action id. */
  superseded: number;
  approvalsGranted: number;
  approvalsDenied: number;
  /** Approvals whose `e`/`d` tag names no contribution record we read. */
  approvalsUnlinked: number;
}

export interface CommunityTrustUnreadable {
  /** 37013 events read incompletely (bad content, no `d`, unknown status). */
  contributions: number;
  /** 46030/46031 events with no readable target tag. */
  approvals: number;
  total: number;
}

export interface CommunityTrustRecord {
  /** Canonical records only (NIP-ORG:385-392 — never double-counted). */
  contributions: ContributionSignal[];
  counts: CommunityTrustCounts;
  unreadable: CommunityTrustUnreadable;
}

interface ContributionDraft {
  eventId: string;
  actionId: string | null;
  author: string;
  createdAt: number;
  action: string;
  reviewStatus: ReviewStatus | "unknown";
}

interface ApprovalDraft {
  eventId: string;
  kind: number;
  createdAt: number;
  /** `e` tag (event id) or `d` tag (action id) naming what was decided. */
  target: string | null;
}

function contentObject(event: NostrEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed content is a null parse, not a crash (org-money convention).
  }
  return null;
}

function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name && t.length >= 1);
  return tag && tag.length >= 2 && tag[1] ? tag[1] : null;
}

/**
 * Parse one kind:37013 event. Null means "no content to read" (counted by the
 * caller); a record published without a `d` tag or with an out-of-vocabulary
 * status is returned *and* counted as incomplete — visible, never dropped
 * (`orgModels.ts` keeps such records under their own event id too).
 */
function parseContribution(event: NostrEvent): ContributionDraft | null {
  if (event.kind !== KIND_CONTRIBUTION_RECORD) return null;
  const actionId = tagValue(event, "d");
  const body = contentObject(event);
  if (!body) return null;
  const rawStatus = body.reviewStatus;
  const status: ReviewStatus | "unknown" = isReviewStatus(rawStatus)
    ? rawStatus
    : "unknown";
  const action = typeof body.action === "string" ? body.action : "";
  return {
    eventId: event.id,
    actionId,
    author: event.pubkey,
    createdAt: event.created_at,
    action,
    reviewStatus: status,
  };
}

/** Parse one 46030/46031 approval; null means "no readable target". */
function parseApproval(event: NostrEvent): ApprovalDraft | null {
  if (event.kind !== KIND_APPROVAL_GRANT && event.kind !== KIND_APPROVAL_DENY) {
    return null;
  }
  const target = tagValue(event, "e") ?? tagValue(event, "d");
  if (!target) return null;
  return {
    eventId: event.id,
    kind: event.kind,
    createdAt: event.created_at,
    target,
  };
}

/**
 * Resolve contribution + approval outcomes for the community scope.
 *
 * Canonical resolution follows NIP-ORG:385-392 exactly (newest `created_at`
 * per action id, tie → lowest event id); records published without a `d` tag
 * stay visible under their own event id rather than vanishing.
 */
export function summarizeCommunityTrustSignals(
  events: readonly NostrEvent[],
): CommunityTrustRecord {
  const drafts: ContributionDraft[] = [];
  const approvals: ApprovalDraft[] = [];
  let unreadableContributions = 0;
  let unreadableApprovals = 0;

  for (const event of events) {
    if (event.kind === KIND_CONTRIBUTION_RECORD) {
      const draft = parseContribution(event);
      if (!draft) {
        unreadableContributions += 1;
        continue;
      }
      if (draft.reviewStatus === "unknown" || draft.actionId === null) {
        unreadableContributions += 1;
      }
      drafts.push(draft);
      continue;
    }
    if (
      event.kind === KIND_APPROVAL_GRANT ||
      event.kind === KIND_APPROVAL_DENY
    ) {
      const approval = parseApproval(event);
      if (!approval) {
        unreadableApprovals += 1;
        continue;
      }
      approvals.push(approval);
    }
  }

  // Canonical record per action id: newest wins, tie → lowest event id.
  const groups = new Map<string, ContributionDraft[]>();
  for (const draft of drafts) {
    const key = draft.actionId ?? `__event__${draft.eventId}`;
    const rows = groups.get(key);
    if (rows) rows.push(draft);
    else groups.set(key, [draft]);
  }
  const canonicalOf = (rows: ContributionDraft[]): ContributionDraft => {
    let best = rows[0];
    for (const row of rows.slice(1)) {
      if (
        row.createdAt > best.createdAt ||
        (row.createdAt === best.createdAt && row.eventId < best.eventId)
      ) {
        best = row;
      }
    }
    return best;
  };

  const contributions: ContributionSignal[] = [];
  const byEventId = new Map<string, ContributionSignal>();
  const byActionId = new Map<string, ContributionSignal>();
  let superseded = 0;
  for (const rows of groups.values()) {
    const canonical = canonicalOf(rows);
    superseded += rows.length - 1;
    const drafter = [...rows].sort(
      (a, b) => a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : 1),
    )[0];
    const signal: ContributionSignal = {
      eventId: canonical.eventId,
      actionId: canonical.actionId,
      author: canonical.author,
      createdAt: canonical.createdAt,
      action: canonical.action,
      reviewStatus: canonical.reviewStatus,
      // A review is republished under the reviewer's own key (NIP-ORG:373-376);
      // same key means the drafter dispositioned their own record.
      reviewedBy:
        rows.length > 1 && canonical.author !== drafter.author
          ? canonical.author
          : null,
      approval: null,
    };
    contributions.push(signal);
    byEventId.set(signal.eventId, signal);
    for (const row of rows) byEventId.set(row.eventId, signal);
    if (signal.actionId) byActionId.set(signal.actionId, signal);
  }
  contributions.sort((a, b) => b.createdAt - a.createdAt);

  let approvalsGranted = 0;
  let approvalsDenied = 0;
  let approvalsUnlinked = 0;
  const orderedApprovals = [...approvals].sort(
    (a, b) => a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : 1),
  );
  for (const approval of orderedApprovals) {
    const granted = approval.kind === KIND_APPROVAL_GRANT;
    if (granted) approvalsGranted += 1;
    else approvalsDenied += 1;
    const target = approval.target;
    const signal =
      target === null
        ? undefined
        : (byActionId.get(target) ?? byEventId.get(target));
    if (!signal) {
      approvalsUnlinked += 1;
      continue;
    }
    // Latest approval that names the record wins.
    signal.approval = granted ? "granted" : "denied";
  }

  const counts: CommunityTrustCounts = {
    accepted: 0,
    rejected: 0,
    appealed: 0,
    pending: 0,
    unknown: 0,
    superseded,
    approvalsGranted,
    approvalsDenied,
    approvalsUnlinked,
  };
  for (const signal of contributions) {
    if (signal.reviewStatus === "accepted") counts.accepted += 1;
    else if (signal.reviewStatus === "rejected") counts.rejected += 1;
    else if (signal.reviewStatus === "appealed") counts.appealed += 1;
    else if (signal.reviewStatus === "pending") counts.pending += 1;
    else counts.unknown += 1;
  }

  return {
    contributions,
    counts,
    unreadable: {
      contributions: unreadableContributions,
      approvals: unreadableApprovals,
      total: unreadableContributions + unreadableApprovals,
    },
  };
}

/** The community breakdown the card renders — same binding as launch rows. */
export function communityDerivation(
  record: CommunityTrustRecord,
): DerivationRow[] {
  const source = `kind ${KIND_CONTRIBUTION_RECORD} · canonical record · reviewStatus`;
  return [
    {
      key: "contributions-accepted",
      label: "Contributions accepted",
      value: record.counts.accepted,
      source: `${source}=accepted`,
    },
    {
      key: "contributions-rejected",
      label: "Contributions rejected",
      value: record.counts.rejected,
      source: `${source}=rejected`,
    },
    {
      key: "contributions-appealed",
      label: "Contributions appealed",
      value: record.counts.appealed,
      source: `${source}=appealed`,
    },
    {
      key: "contributions-pending",
      label: "Contributions awaiting review",
      value: record.counts.pending,
      source: `${source}=pending`,
    },
    {
      key: "contributions-unknown",
      label: "Contributions with an unreadable status",
      value: record.counts.unknown,
      source: `${KIND_CONTRIBUTION_RECORD} payload — counted, not dropped`,
    },
    {
      key: "contributions-superseded",
      label: "Superseded versions (not double-counted)",
      value: record.counts.superseded,
      source: `${KIND_CONTRIBUTION_RECORD} · newest per action id wins (NIP-ORG)`,
    },
    {
      key: "approvals-granted",
      label: "Approvals granted",
      value: record.counts.approvalsGranted,
      source: `kind ${KIND_APPROVAL_GRANT}`,
    },
    {
      key: "approvals-denied",
      label: "Approvals denied",
      value: record.counts.approvalsDenied,
      source: `kind ${KIND_APPROVAL_DENY}`,
    },
    {
      key: "approvals-unlinked",
      label: "Approvals naming no contribution",
      value: record.counts.approvalsUnlinked,
      source: `kind ${KIND_APPROVAL_GRANT}/${KIND_APPROVAL_DENY} · e/d tag matched nothing`,
    },
    {
      key: "community-unreadable",
      label: "Records read incompletely",
      value: record.unreadable.total,
      source: "37013/46030/46031 payloads — counted, not dropped",
    },
  ];
}

/** `"empty"` → "No contribution records yet", never a zero-filled ledger. */
export function communityTrackState(
  record: CommunityTrustRecord,
): "empty" | "recorded" {
  return record.contributions.length > 0 ||
    record.counts.approvalsGranted + record.counts.approvalsDenied > 0
    ? "recorded"
    : "empty";
}

export const EMPTY_COMMUNITY_COPY = "No contribution records yet.";
