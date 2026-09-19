import type { RelayEvent } from "../../shared/api/types";
import { KIND_DELETION } from "@/shared/constants/kinds";

// NIP-ORG content keys are camelCase and canonical: node
// { name, kind, parent, holders, agentSeats, scope, ui }, grant
// { issuer, grantee, via, verbs, parentGrant, expires, revoked }, budget
// { subject, window, limits, onExceed }. There is deliberately no
// snake_case fallback: the branch is unreleased.

/** A grant/node/budget is revoked by a kind:5 tombstone or a `revoked: true` republish. */
function isRevoked(
  event: RelayEvent,
  content: Record<string, unknown>,
): boolean {
  return event.kind === KIND_DELETION || content.revoked === true;
}

function parseContent(event: RelayEvent): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed content — return defaults
  }
  return {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

// ── Org node (kind:37010) ──────────────────────────────────────────────────

export type OrgNodeKind = "role" | "team" | "agent_seat";

export type OrgNodeUi = {
  icon?: string;
  color?: string;
  description?: string;
};

export type OrgNode = {
  eventId: string;
  dtag: string;
  name: string;
  kind: OrgNodeKind;
  parent?: string;
  /** Human seat holders (pubkeys). */
  holders: string[];
  /** Agent seat occupants (pubkeys). */
  agentSeats: string[];
  ui?: OrgNodeUi;
  createdAt: number;
  revoked: boolean;
};

export function eventToOrgNode(event: RelayEvent): OrgNode {
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = parseContent(event);
  const kind = content.kind;

  return {
    eventId: event.id,
    dtag,
    name: (typeof content.name === "string" && content.name) || dtag,
    kind:
      kind === "team" || kind === "agent_seat" ? (kind as OrgNodeKind) : "role",
    parent: typeof content.parent === "string" ? content.parent : undefined,
    holders: stringArray(content.holders),
    agentSeats: stringArray(content.agentSeats),
    ui: (content.ui ?? undefined) as OrgNodeUi | undefined,
    createdAt: event.created_at,
    revoked: isRevoked(event, content),
  };
}

// ── Org grant (kind:37011) ─────────────────────────────────────────────────

export type OrgGrant = {
  eventId: string;
  dtag: string;
  grantee: string;
  via: string;
  verbs: string[];
  parentGrant?: string;
  expires?: number;
  revoked: boolean;
  createdAt: number;
};

export function eventToOrgGrant(event: RelayEvent): OrgGrant {
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const granteeTag = event.tags.find((t) => t[0] === "p");
  const content = parseContent(event);
  const expires = content.expires;

  return {
    eventId: event.id,
    dtag,
    // The canonical grantee lives in the content; the `p` tag mirrors it.
    grantee:
      (typeof content.grantee === "string" && content.grantee) ||
      granteeTag?.[1] ||
      "",
    via: (typeof content.via === "string" && content.via) || "",
    verbs: stringArray(content.verbs),
    parentGrant:
      typeof content.parentGrant === "string" ? content.parentGrant : undefined,
    expires: typeof expires === "number" ? expires : undefined,
    revoked: isRevoked(event, content),
    createdAt: event.created_at,
  };
}

// ── Org budget (kind:37012) ────────────────────────────────────────────────

export type SpendLimit = {
  amount: number;
  unit: string;
};

export type TaskLimits = {
  create?: number;
  approve?: number;
};

export type BudgetLimits = {
  spend?: SpendLimit;
  runs?: number;
  tasks?: TaskLimits;
};

export type BudgetWindow = "epoch" | "day" | "week" | "month";

export type OnExceed = "require-approval";

export type OrgBudget = {
  eventId: string;
  dtag: string;
  subject: string;
  window: BudgetWindow;
  limits: BudgetLimits;
  onExceed: OnExceed;
  createdAt: number;
  revoked: boolean;
};

export function eventToOrgBudget(event: RelayEvent): OrgBudget {
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = parseContent(event);

  return {
    eventId: event.id,
    dtag,
    subject: (typeof content.subject === "string" && content.subject) || "",
    window: (content.window === "day" ||
    content.window === "week" ||
    content.window === "month"
      ? content.window
      : "epoch") as BudgetWindow,
    limits: (content.limits ?? {}) as BudgetLimits,
    onExceed:
      content.onExceed === "require-approval"
        ? "require-approval"
        : "require-approval",
    createdAt: event.created_at,
    revoked: isRevoked(event, content),
  };
}

// ── Contribution record (kind:37013) ───────────────────────────────────────

export type HumanVsAi = {
  human: number;
  ai: number;
};

export type ReviewStatus = "pending" | "accepted" | "rejected" | "appealed";

export type ContributionOutcome = {
  effect?: string;
  harm?: string;
};

export type AppealEntry = {
  status: string;
  at: number;
};

export type ContributionRecord = {
  eventId: string;
  dtag: string;
  action: string;
  dimensions: Record<string, number>;
  outcome?: ContributionOutcome;
  evidence: string[];
  humanVsAi: HumanVsAi;
  informedBy: string[];
  classifierVersion?: string;
  reviewStatus: ReviewStatus;
  appealHistory: AppealEntry[];
  createdAt: number;
};

export function eventToContributionRecord(
  event: RelayEvent,
): ContributionRecord {
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = parseContent(event);

  const evidence = event.tags.filter((t) => t[0] === "e").map((t) => t[1]);

  // Canonical informedBy is the camelCase content key; fall back to the
  // historical `a`-tag encoding.
  const informedBy = stringArray(content.informedBy).length
    ? stringArray(content.informedBy)
    : event.tags.filter((t) => t[0] === "a").map((t) => t[1]);

  const humanVsAi = content.humanVsAi as HumanVsAi | undefined;

  return {
    eventId: event.id,
    dtag,
    action: (typeof content.action === "string" && content.action) || "",
    dimensions: (content.dimensions ?? {}) as Record<string, number>,
    outcome: content.outcome as ContributionOutcome | undefined,
    evidence,
    humanVsAi: humanVsAi ?? { human: 1, ai: 0 },
    informedBy,
    classifierVersion:
      typeof content.classifierVersion === "string"
        ? content.classifierVersion
        : undefined,
    reviewStatus: (content.reviewStatus === "accepted" ||
    content.reviewStatus === "rejected" ||
    content.reviewStatus === "appealed"
      ? content.reviewStatus
      : "pending") as ReviewStatus,
    appealHistory: Array.isArray(content.appealHistory)
      ? (content.appealHistory as AppealEntry[])
      : [],
    createdAt: event.created_at,
  };
}

// ── Read models ─────────────────────────────────────────────────────────────

export type OrgChart = {
  nodes: OrgNode[];
  grants: OrgGrant[];
  budgets: OrgBudget[];
};
