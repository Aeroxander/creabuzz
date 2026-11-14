/**
 * Dashboard derivations for the org surface (docs/paperclip-ux-reference.md
 * §2.1): blocking banners, and the recent-activity row model. Pure logic —
 * the React shell lives in ../ui/OrgDashboard.tsx.
 *
 * Banner contract (§2.1 rule 1): every banner states cause + consequence +
 * ONE action, and banners only appear when something actually blocks the
 * run. Max three render, then a "+N more" line.
 */
import { KIND_APPROVAL_REQUEST } from "@/shared/constants/kinds";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { StatusTone } from "@/shared/ui/statusTone";

import type {
  ContributionRecord,
  OrgBudget,
  OrgGrant,
  OrgNode,
} from "../orgModels";
import { consumptionPercentage } from "./budgetConsumption";
import { budgetLimitSummary, budgetSubjectLabel } from "./budgetForm";
import { pluralize } from "./format";
import type { AgentLiveness } from "./nodeLiveness";

// Mirrors buzz-core's approval command kinds (kind:46030 grant / 46031 deny)
// resolving a kind:46010 request. Kept local to the org surface, same
// scoping choice as features/home/lib/needsMe.ts.
export const KIND_APPROVAL_GRANT = 46030;
export const KIND_APPROVAL_DENY = 46031;

/** Bounded read for the dashboard extras fetch (receipts + approvals). */
export const ACTIVITY_FETCH_LIMIT = 200;

/** Hard cap on rendered activity rows. */
export const ACTIVITY_ROW_LIMIT = 12;

// ── Blocking banners ───────────────────────────────────────────────────────

/** Where the banner's single action leads. Grants, budgets, and nodes all
 * resolve on the Chart tab (which owns them), so both targets open it. */
export type BannerTarget = "budgets" | "grants";

export type BlockingBanner = {
  key: string;
  tone: StatusTone;
  /** Cause + consequence in one line. */
  title: string;
  /** The consequence made concrete (what stops working). */
  detail: string;
  /** The ONE action, phrased as a verb. */
  actionLabel: string;
  actionTarget: BannerTarget;
};

export type BudgetUtilizationEntryLike = {
  budget: OrgBudget;
  summary: {
    consumed: number;
    limit?: number;
    truncated: boolean;
    windowStart: number | null;
  } | null;
};

const BANNER_THRESHOLD_PERCENT = 90;

export type BannerInput = {
  budgets: ReadonlyArray<OrgBudget>;
  utilizations: ReadonlyArray<BudgetUtilizationEntryLike>;
  grants: ReadonlyArray<OrgGrant>;
  /** Agent-seat liveness keyed by lowercase seat pubkey. */
  liveness: ReadonlyMap<string, AgentLiveness>;
  /** All known org nodes (to find grantee seats and display names). */
  nodes: ReadonlyArray<OrgNode>;
  namesByPubkey: ReadonlyMap<string, string>;
  nowSeconds: number;
};

function grantIsActive(grant: OrgGrant, nowSeconds: number): boolean {
  return (
    !grant.revoked &&
    (grant.expires === undefined || nowSeconds < grant.expires)
  );
}

function displayName(
  pubkey: string,
  namesByPubkey: ReadonlyMap<string, string>,
): string {
  // Named seats read as names; anything else takes the one canonical
  // truncated form (never the raw 64-char key).
  return (
    namesByPubkey.get(pubkey.trim().toLowerCase()) ?? truncatePubkey(pubkey)
  );
}

/**
 * Blocking banners, worst first: over-budget agents (hard stop), expired
 * grants still anchoring active ones, then offline agents holding grants.
 */
export function deriveBlockingBanners(input: BannerInput): BlockingBanner[] {
  const banners: BlockingBanner[] = [];

  // 1. Budgets at/over the hard-stop threshold. Only runs ceilings can be
  // measured against turn metrics, so only those produce a percentage.
  const overBudget: Array<{ banner: BlockingBanner; percent: number }> = [];
  for (const entry of input.utilizations) {
    const budget = entry.budget;
    if (budget.revoked || !entry.summary) continue;
    const percent = consumptionPercentage(entry.summary);
    if (percent === null || percent < BANNER_THRESHOLD_PERCENT) continue;
    const rounded = Math.round(percent);
    overBudget.push({
      percent,
      banner: {
        key: `budget-${budget.dtag}`,
        tone: "blocking",
        title: `${budgetSubjectLabel(budget.subject, (key) => displayName(key, input.namesByPubkey))} hit ${rounded}% of its ${budget.window} runs budget`,
        detail: "Further turns will be rejected.",
        actionLabel: "Raise the budget",
        actionTarget: "budgets",
      },
    });
  }
  overBudget.sort((a, b) => b.percent - a.percent);
  banners.push(...overBudget.map((entry) => entry.banner));

  // 2. Expired grants still referenced as parentGrant by active ones.
  let expiredParentCount = 0;
  for (const grant of input.grants) {
    if (!grantIsActive(grant, input.nowSeconds) || !grant.parentGrant) continue;
    const parent = input.grants.find((g) => g.dtag === grant.parentGrant);
    if (
      parent &&
      !parent.revoked &&
      parent.expires !== undefined &&
      input.nowSeconds >= parent.expires
    ) {
      expiredParentCount += 1;
    }
  }
  if (expiredParentCount > 0) {
    banners.push({
      key: "expired-parent-grants",
      tone: "blocking",
      title: `${pluralize(expiredParentCount, "expired grant")} still parent${expiredParentCount === 1 ? "s" : ""} active delegations`,
      detail: "Expired authority is still anchoring live grants.",
      actionLabel: "Review grants",
      actionTarget: "grants",
    });
  }

  // 3. Agents gone with active grants: their work is paused until they
  // return or the grant is revoked.
  const goneAgents: string[] = [];
  for (const node of input.nodes) {
    for (const seat of node.agentSeats) {
      const seatLower = seat.trim().toLowerCase();
      if (input.liveness.get(seatLower)?.status !== "gone") continue;
      const hasActiveGrant = input.grants.some(
        (grant) =>
          grantIsActive(grant, input.nowSeconds) &&
          grant.grantee.trim().toLowerCase() === seatLower,
      );
      if (hasActiveGrant && !goneAgents.includes(seatLower)) {
        goneAgents.push(seatLower);
      }
    }
  }
  if (goneAgents.length > 0) {
    banners.push({
      key: "gone-agents-with-grants",
      tone: "waiting",
      title: `${pluralize(goneAgents.length, "agent")} offline with active grants`,
      detail: "Their work is paused until they come back.",
      actionLabel: "Open grants",
      actionTarget: "grants",
    });
  }

  return banners;
}

/** Hard cap on rendered banners; the rest collapse into "+N more". */
export const BANNER_LIMIT = 3;

// ── Activity rows ──────────────────────────────────────────────────────────

/**
 * The two owning tabs an activity row can open: contribution records resolve
 * on the Contributions tab; grants, budgets, receipts, and approvals resolve
 * on the Chart tab (which renders them), so "grants" maps onto it.
 */
export type ActivityTargetTab = "contributions" | "grants";

export type ActivityRow = {
  key: string;
  kind: number;
  createdAt: number;
  tone: StatusTone;
  /** One human-readable line. Never raw JSON. */
  description: string;
  /** Author pubkey (identity shown as the compact PubKey chip). */
  actorPubkey: string;
  targetTab: ActivityTargetTab;
};

export type ActivityEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: ReadonlyArray<readonly string[]>;
  content: string;
};

export type ActivityInput = {
  nodes: ReadonlyArray<OrgNode>;
  grants: ReadonlyArray<OrgGrant>;
  budgets: ReadonlyArray<OrgBudget>;
  contributions: ReadonlyArray<ContributionRecord>;
  /** Raw kind:37014 / 46010 / 46030 / 46031 events (no model layer yet). */
  extras: ReadonlyArray<ActivityEventLike>;
  namesByPubkey: ReadonlyMap<string, string>;
  namesByDtag: ReadonlyMap<string, string>;
};

function tagValue(
  tags: ReadonlyArray<readonly string[]>,
  name: string,
): string | null {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Defensive JSON parse: agent/relay content is untrusted display text. */
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

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 10)}…` : value;
}

function contributionTone(record: ContributionRecord): StatusTone {
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

function reviewLabel(record: ContributionRecord): string {
  switch (record.reviewStatus) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "appealed":
      return "appealed";
    default:
      return "pending review of";
  }
}

function extrasToRow(
  event: ActivityEventLike,
  input: ActivityInput,
): ActivityRow | null {
  const createdAt = event.created_at;
  if (typeof createdAt !== "number") return null;
  const actorPubkey = event.pubkey ?? "";
  switch (event.kind) {
    case 37014: {
      // The receipt's meaningful fields (NIP-ORG §37014: amount + unit +
      // subject) read as the row; the `d` slug never surfaces.
      const parsed = parseJsonObject(event.content);
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
      const amountText = amount !== null && unit ? `${amount} ${unit}` : null;
      return {
        key: event.id,
        kind: event.kind,
        createdAt,
        tone: "ok",
        description: amountText
          ? `Spend recorded: ${amountText}${by}`
          : `Spend recorded on-chain${by}`,
        actorPubkey,
        targetTab: "grants",
      };
    }
    case KIND_APPROVAL_REQUEST: {
      const token = tagValue(event.tags, "d");
      if (!token) return null;
      const parsed = parseJsonObject(event.content);
      if (parsed && stringField(parsed, "type") === "budget-exceeded") {
        const subject = stringField(parsed, "subject") ?? "";
        const counterType = stringField(parsed, "counterType") ?? "budget";
        const window = stringField(parsed, "window") ?? "window";
        const limit = parsed.limit;
        const limitText =
          typeof limit === "number" && Number.isFinite(limit)
            ? `${limit} ${counterType}/${window}`
            : `${counterType}/${window}`;
        return {
          key: event.id,
          kind: event.kind,
          createdAt,
          tone: "waiting",
          description: `Budget approval requested: ${displayName(subject, input.namesByPubkey)} over ${limitText}`,
          actorPubkey,
          targetTab: "grants",
        };
      }
      // Workflow requests carry plain-text content; a first line at most.
      const firstLine = event.content.trim().split("\n")[0] ?? "";
      return {
        key: event.id,
        kind: event.kind,
        createdAt,
        tone: "waiting",
        description: firstLine
          ? `Approval requested: ${firstLine}`
          : `Approval requested: ${shortId(token)}`,
        actorPubkey,
        targetTab: "grants",
      };
    }
    case KIND_APPROVAL_GRANT:
    case KIND_APPROVAL_DENY: {
      const token = tagValue(event.tags, "d");
      if (!token) return null;
      const granted = event.kind === KIND_APPROVAL_GRANT;
      return {
        key: event.id,
        kind: event.kind,
        createdAt,
        tone: granted ? "ok" : "blocking",
        description: `Approval ${granted ? "granted" : "denied"}: ${shortId(token)}`,
        actorPubkey,
        targetTab: "grants",
      };
    }
    default:
      return null;
  }
}

/**
 * Activity rows, newest first (bounded to ACTIVITY_ROW_LIMIT by the caller
 * or here — this function caps at the limit itself so callers cannot render
 * an unbounded list).
 */
export function deriveActivityRows(input: ActivityInput): ActivityRow[] {
  const rows: ActivityRow[] = [];

  for (const node of input.nodes) {
    rows.push({
      key: node.eventId,
      kind: 37010,
      createdAt: node.createdAt,
      tone: "neutral",
      description: `Node updated: ${input.namesByDtag.get(node.dtag) ?? node.name}`,
      actorPubkey: node.author,
      targetTab: "grants",
    });
  }

  for (const grant of input.grants) {
    const verbs = grant.verbs.join(", ") || grant.dtag;
    const via = grant.via
      ? (input.namesByDtag.get(grant.via) ?? grant.via)
      : null;
    const scope = via ? ` via ${via}` : "";
    rows.push({
      key: grant.eventId,
      kind: 37011,
      createdAt: grant.createdAt,
      tone: grant.revoked ? "blocking" : "review",
      description: grant.revoked
        ? `Grant revoked: ${verbs}${scope}`
        : `${displayName(grant.issuer, input.namesByPubkey)} granted ${displayName(grant.grantee, input.namesByPubkey)}: ${verbs}${scope}`,
      actorPubkey: grant.author,
      targetTab: "grants",
    });
  }

  for (const budget of input.budgets) {
    rows.push({
      key: budget.eventId,
      kind: 37012,
      createdAt: budget.createdAt,
      tone: "waiting",
      description: `Budget set for ${budgetSubjectLabel(budget.subject, (key) => displayName(key, input.namesByPubkey))}: ${budgetLimitSummary(budget)}`,
      actorPubkey: budget.author,
      targetTab: "grants",
    });
  }

  for (const record of input.contributions) {
    const action = record.action.trim() || record.dtag;
    rows.push({
      key: record.eventId,
      kind: 37013,
      createdAt: record.createdAt,
      tone: contributionTone(record),
      description: `${reviewLabel(record)}: ${action}`,
      actorPubkey: record.author,
      targetTab: "contributions",
    });
  }

  for (const event of input.extras) {
    const row = extrasToRow(event, input);
    if (row) rows.push(row);
  }

  rows.sort(
    (a, b) =>
      b.createdAt - a.createdAt || a.kind - b.kind || (a.key < b.key ? -1 : 1),
  );
  return rows.slice(0, ACTIVITY_ROW_LIMIT);
}

// ── Relative time ──────────────────────────────────────────────────────────

/**
 * Compact relative label for activity rows ("just now", "5m ago", "3h ago",
 * "2d ago"). Deterministic given (unixSeconds, nowSeconds) so it is
 * unit-testable without clock mocking.
 */
export function relativeTimeLabel(
  unixSeconds: number,
  nowSeconds: number,
): string {
  const seconds = Math.max(0, Math.floor(nowSeconds - unixSeconds));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
