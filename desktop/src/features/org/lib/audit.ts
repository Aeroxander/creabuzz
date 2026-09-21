/**
 * Audit-log derivations for the org surface (NIP-ORG evidence spine).
 *
 * Every structural org change is a signed, community-level Nostr event, so
 * the event stream IS the evidence: this module turns the raw kinds
 * (37010–37014 + 46010/46030/46031) into attributed, newest-first audit
 * rows. Pure logic — the React shell lives in ../ui/OrgAuditView.tsx.
 *
 * Honesty contract: the verify modal re-fetches and checks PRESENCE +
 * RECENCY of the same events. Exact hash-chain verification is an
 * operator-path upgrade (the relay's audit hash chain and `buzz-admin`
 * operator view); this surface must not claim cryptographic verification
 * it does not perform.
 */
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { StatusTone } from "@/shared/ui/statusTone";

import {
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_CONTRIBUTION_RECORD,
  KIND_ORG_BUDGET,
  KIND_ORG_GRANT,
  KIND_ORG_NODE,
} from "@/shared/constants/kinds";

import {
  eventToContributionRecord,
  eventToOrgBudget,
  eventToOrgGrant,
  eventToOrgNode,
} from "../orgModels";

// Mirrors buzz-core's approval command kinds (kind:46030 grant / 46031 deny)
// resolving a kind:46010 request — same scoping choice as lib/dashboard.ts.
export const KIND_APPROVAL_REQUEST = 46010;
export const KIND_APPROVAL_GRANT = 46030;
export const KIND_APPROVAL_DENY = 46031;

/** All structural org kinds, for the bounded audit fetch. */
export const AUDIT_EVENT_KINDS = [
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_APPROVAL_REQUEST,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
] as const;

/** Bounded read: the audit fetch never pulls more than this many events. */
export const AUDIT_FETCH_LIMIT = 200;

export type AuditEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: ReadonlyArray<readonly string[]>;
  content: string;
};

export type AuditRow = {
  key: string;
  kind: number;
  createdAt: number;
  tone: StatusTone;
  /** One human-readable line. Never raw JSON. */
  description: string;
  /** Author pubkey (identity resolved by the view). */
  actorPubkey: string;
};

export type AuditInput = {
  events: ReadonlyArray<AuditEventLike>;
  namesByPubkey: ReadonlyMap<string, string>;
  namesByDtag: ReadonlyMap<string, string>;
};

// ── Content parsing helpers (defensive — agent/relay content is untrusted) ─

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain-text or malformed content — callers fall back, never render raw.
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function tagValue(
  tags: ReadonlyArray<readonly string[]>,
  name: string,
): string | null {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 10)}…` : value;
}

/** Compact `0x…` display for a DAO address in a binding line. */
function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

function displayName(
  pubkey: string,
  namesByPubkey: ReadonlyMap<string, string>,
): string {
  return (
    namesByPubkey.get(pubkey.trim().toLowerCase()) ?? truncatePubkey(pubkey)
  );
}

function budgetLimitText(budget: ReturnType<typeof eventToOrgBudget>): string {
  const limits = budget.limits;
  const parts = [
    limits.runs != null && `${limits.runs} runs/${budget.window}`,
    limits.spend != null &&
      `${limits.spend.amount} ${limits.spend.unit}/${budget.window}`,
    limits.tasks?.create != null &&
      `${limits.tasks.create} tasks created/${budget.window}`,
    limits.tasks?.approve != null &&
      `${limits.tasks.approve} tasks approved/${budget.window}`,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "no limits";
}

function contributionTone(
  record: ReturnType<typeof eventToContributionRecord>,
): StatusTone {
  switch (record.reviewStatus) {
    case "accepted":
      return "ok";
    case "rejected":
      return "blocking";
    case "appealed":
      return "review";
    default:
      return "waiting";
  }
}

function contributionLabel(
  record: ReturnType<typeof eventToContributionRecord>,
): string {
  switch (record.reviewStatus) {
    case "accepted":
      return "accepted contribution";
    case "rejected":
      return "rejected contribution";
    case "appealed":
      return "appealed contribution";
    default:
      return "pending contribution";
  }
}

/** Per-kind glyph tone (docs/paperclip-ux-reference.md §5 status semantics). */
export function auditKindTone(kind: number): StatusTone {
  switch (kind) {
    case KIND_ORG_NODE:
      return "neutral";
    case KIND_ORG_GRANT:
      return "review";
    case KIND_ORG_BUDGET:
      return "waiting";
    case KIND_BUDGET_SPEND_RECEIPT:
      return "ok";
    // Approvals are the live decision surface (blue = liveness).
    case KIND_APPROVAL_REQUEST:
    case KIND_APPROVAL_GRANT:
    case KIND_APPROVAL_DENY:
      return "live";
    default:
      return "neutral";
  }
}

/** One-line, human-readable action for one audit event. Never raw JSON. */
export function auditDescription(
  event: AuditEventLike,
  input: Pick<AuditInput, "namesByPubkey" | "namesByDtag">,
): string | null {
  const parsed = parseJsonObject(event.content);
  switch (event.kind) {
    case KIND_ORG_NODE: {
      const node = eventToOrgNode(event as never);
      // The binding lives at content.onchain { chain, dao, boundAt }.
      const onchain =
        parsed && typeof parsed.onchain === "object" && parsed.onchain
          ? (parsed.onchain as Record<string, unknown>)
          : null;
      const dao = onchain ? stringField(onchain, "dao") : null;
      if (dao) {
        const chain =
          (onchain ? stringField(onchain, "chain") : null) ?? "onchain";
        return `Bound the org root to ${chain} DAO ${shortAddress(dao)}`;
      }
      return `Node updated: ${input.namesByDtag.get(node.dtag) ?? node.name}`;
    }
    case KIND_ORG_GRANT: {
      const grant = eventToOrgGrant(event as never);
      const verbs = grant.verbs.join(", ") || grant.dtag;
      const via = grant.via
        ? ` via ${input.namesByDtag.get(grant.via) ?? grant.via}`
        : "";
      if (grant.revoked) {
        return `Revoked grant ${verbs}${via}`;
      }
      return `Granted ${displayName(grant.grantee, input.namesByPubkey)}: ${verbs}${via}`;
    }
    case KIND_ORG_BUDGET: {
      const budget = eventToOrgBudget(event as never);
      return `Budget set for ${displayName(budget.subject, input.namesByPubkey)}: ${budgetLimitText(budget)}`;
    }
    case KIND_CONTRIBUTION_RECORD: {
      const record = eventToContributionRecord(event as never);
      const action = record.action.trim() || record.dtag;
      return `${contributionLabel(record)}: ${action}`;
    }
    case KIND_BUDGET_SPEND_RECEIPT: {
      const amount =
        parsed &&
        typeof parsed.amount === "number" &&
        Number.isFinite(parsed.amount)
          ? parsed.amount
          : null;
      const unit = parsed ? stringField(parsed, "unit") : null;
      const subject = parsed ? stringField(parsed, "subject") : null;
      const by = subject
        ? ` by ${displayName(subject, input.namesByPubkey)}`
        : "";
      return amount !== null && unit
        ? `Spend recorded: ${amount} ${unit}${by}`
        : `Spend recorded on-chain${by}`;
    }
    case KIND_APPROVAL_REQUEST: {
      const token = tagValue(event.tags, "d");
      if (parsed && stringField(parsed, "type") === "budget-exceeded") {
        const subject = stringField(parsed, "subject") ?? "";
        const counterType = stringField(parsed, "counterType") ?? "budget";
        const window = stringField(parsed, "window") ?? "window";
        const limit = parsed.limit;
        const limitText =
          typeof limit === "number" && Number.isFinite(limit)
            ? `${limit} ${counterType}/${window}`
            : `${counterType}/${window}`;
        return `Budget approval requested: ${displayName(subject, input.namesByPubkey)} over ${limitText}`;
      }
      const firstLine = event.content.trim().split("\n")[0] ?? "";
      return firstLine
        ? `Approval requested: ${firstLine}`
        : `Approval requested: ${token ? shortId(token) : shortId(event.id)}`;
    }
    case KIND_APPROVAL_GRANT:
    case KIND_APPROVAL_DENY: {
      const token = tagValue(event.tags, "d");
      const granted = event.kind === KIND_APPROVAL_GRANT;
      return `Approval ${granted ? "granted" : "denied"}: ${token ? shortId(token) : shortId(event.id)}`;
    }
    default:
      return null;
  }
}

/**
 * Audit rows, newest first. Every fetched event renders — the audit view is
 * the evidence spine, so unlike the dashboard feed there is no extra row cap
 * beyond the bounded fetch itself (see AUDIT_FETCH_LIMIT).
 */
export function deriveAuditRows(input: AuditInput): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const event of input.events) {
    if (typeof event.created_at !== "number" || !event.id) continue;
    const description = auditDescription(event, input);
    if (!description) continue;
    const kind = event.kind;
    // Lifecycle refinements over the base kind tone: a revoked grant is
    // blocking; a contribution inherits its review outcome.
    let tone = auditKindTone(kind);
    if (kind === KIND_ORG_GRANT) {
      const revoked = parseJsonObject(event.content)?.revoked === true;
      if (revoked) tone = "blocking";
    } else if (kind === KIND_CONTRIBUTION_RECORD) {
      tone = contributionTone(eventToContributionRecord(event as never));
    }
    rows.push({
      key: event.id,
      kind,
      createdAt: event.created_at,
      tone,
      description,
      actorPubkey: event.pubkey ?? "",
    });
  }
  rows.sort(
    (a, b) =>
      b.createdAt - a.createdAt || a.kind - b.kind || (a.key < b.key ? -1 : 1),
  );
  return rows;
}

// ── Full timestamp ─────────────────────────────────────────────────────────

/**
 * Deterministic full timestamp for audit rows (ISO 8601 UTC) — the
 * machine-checkable counterpart of the relative label.
 */
export function fullTimestampLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

// ── Verify summary (presence + recency, honestly labeled) ──────────────────

/** How many newest row ids the verify modal re-checks against a fresh fetch. */
export const AUDIT_VERIFY_SAMPLE = 12;

export type AuditVerifyInput = {
  /** The ids the viewer was looking at, newest first. */
  previousTopIds: ReadonlyArray<string>;
  /** Ids from the fresh re-fetch, newest first. */
  refetchedIds: ReadonlyArray<string>;
  /** The fresh fetch hit its bounded limit (older history may exist). */
  hitFetchLimit: boolean;
};

export type AuditVerifySummary = {
  /** "verified" — every sampled row id is still present in the fresh fetch. */
  state: "verified" | "degraded";
  checkedCount: number;
  presentCount: number;
  missingIds: string[];
  hitFetchLimit: boolean;
};

/**
 * Presence + recency check: the newest N entries the viewer saw are looked
 * up in a fresh re-fetch. This is NOT a hash-chain proof — the modal labels
 * it as a presence check and points at the operator-path upgrade for exact
 * chain verification.
 */
export function deriveVerifySummary(
  input: AuditVerifyInput,
): AuditVerifySummary {
  const sample = input.previousTopIds.slice(0, AUDIT_VERIFY_SAMPLE);
  const fresh = new Set(input.refetchedIds);
  const missingIds = sample.filter((id) => !fresh.has(id));
  return {
    state: missingIds.length === 0 ? "verified" : "degraded",
    checkedCount: sample.length,
    presentCount: sample.length - missingIds.length,
    missingIds,
    hitFetchLimit: input.hitFetchLimit,
  };
}
