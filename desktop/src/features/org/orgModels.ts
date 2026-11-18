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

/** Delegation scope of a node (NIP-ORG §37010, camelCase keys). */
export type OrgScope = {
  readBelow: boolean;
  assignBelow: boolean;
  canGrant: string[];
};

function parseScope(value: unknown): OrgScope {
  const empty: OrgScope = {
    readBelow: false,
    assignBelow: false,
    canGrant: [],
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return empty;
  }
  const obj = value as Record<string, unknown>;
  return {
    readBelow: obj.readBelow === true,
    assignBelow: obj.assignBelow === true,
    canGrant: stringArray(obj.canGrant),
  };
}

/**
 * Opt-in DAO binding on an org root node (NIP-ORG §"Opt-in onchain
 * binding"): `content.onchain { chain, dao, boundAt }`. Read-only.
 */
export type OrgNodeOnchain = {
  chain: string;
  dao: string;
  boundAt?: number;
};

function parseNodeOnchain(value: unknown): OrgNodeOnchain | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.chain !== "string" || !obj.chain) return undefined;
  if (typeof obj.dao !== "string" || !obj.dao) return undefined;
  return {
    chain: obj.chain,
    dao: obj.dao,
    boundAt:
      typeof obj.boundAt === "number" && Number.isFinite(obj.boundAt)
        ? obj.boundAt
        : undefined,
  };
}

export type OrgNode = {
  eventId: string;
  /** Event author pubkey (lowercased) — the identity that published it. */
  author: string;
  dtag: string;
  name: string;
  kind: OrgNodeKind;
  parent?: string;
  /** Human seat holders (pubkeys). */
  holders: string[];
  /** Agent seat occupants (pubkeys). */
  agentSeats: string[];
  ui?: OrgNodeUi;
  scope: OrgScope;
  /** Present only when the node's community has bound its root to a DAO. */
  onchain?: OrgNodeOnchain;
  createdAt: number;
  revoked: boolean;
};

export function eventToOrgNode(event: RelayEvent): OrgNode {
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = parseContent(event);
  const kind = content.kind;

  return {
    eventId: event.id,
    author: event.pubkey.toLowerCase(),
    dtag,
    name: (typeof content.name === "string" && content.name) || dtag,
    kind:
      kind === "team" || kind === "agent_seat" ? (kind as OrgNodeKind) : "role",
    parent: typeof content.parent === "string" ? content.parent : undefined,
    holders: stringArray(content.holders),
    agentSeats: stringArray(content.agentSeats),
    ui: (content.ui ?? undefined) as OrgNodeUi | undefined,
    scope: parseScope(content.scope),
    onchain: parseNodeOnchain(content.onchain),
    createdAt: event.created_at,
    revoked: isRevoked(event, content),
  };
}

// ── Org grant (kind:37011) ─────────────────────────────────────────────────

export type OrgGrant = {
  eventId: string;
  /** Event author pubkey (lowercased) — the identity that published it. */
  author: string;
  dtag: string;
  /** Signer/issuer pubkey (content.issuer; empty when the event omits it). */
  issuer: string;
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
    author: event.pubkey.toLowerCase(),
    dtag,
    issuer: (typeof content.issuer === "string" && content.issuer) || "",
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
// `subject` is the 64-hex pubkey of the agent the budget covers, or "*" for
// the community default (see lib/budgetForm.ts). It is never an org node id.

export type SpendLimit = {
  amount: number;
  unit: string;
};

export type TaskLimits = {
  create?: number;
  approve?: number;
};

/** Governance-action ceilings (kinds 47004/47005), counted by the relay. */
export type GovernanceLimits = {
  proposal?: number;
  vote?: number;
  execute?: number;
};

export type BudgetLimits = {
  spend?: SpendLimit;
  runs?: number;
  tasks?: TaskLimits;
  governance?: GovernanceLimits;
  /** Chat messages an agent may author per window (relay-enforced). */
  messages?: number;
  /** LLM gateway calls per window (relay-enforced); wire key `llmCalls`. */
  llmCalls?: number;
  /** LLM spend in US cents per window (relay-enforced); wire key `llmCostCents`. */
  llmCostCents?: number;
};

export type BudgetWindow = "epoch" | "day" | "week" | "month";

/**
 * Optional onchain binding for a budget's SPEND ceiling (NIP-ORG §37012).
 * `subject` is the budgeted agent's 32-byte pubkey — same value as the
 * budget's `subject`.
 */
export type OnchainBinding = {
  chain: string;
  contract: string;
  subject: string;
};

export type OnExceed = "require-approval";

// ── Performance-linked autonomy (NIP-ORG § Performance-linked autonomy) ─────

export type OnViolation = "base" | "require-approval" | "revoke";

export type PerformanceTier = {
  minAccepted: number;
  limits: BudgetLimits;
};

export type ViolationThreshold = {
  rejected: number;
};

export type PerformanceLink = {
  window: BudgetWindow;
  /** When present, only records carrying at least one dimension count. */
  dimensions?: string[];
  tiers: PerformanceTier[];
  onViolation: OnViolation;
  violationThreshold?: ViolationThreshold;
};

/**
 * Read the optional `onchain` spend-binding object from budget content.
 * Returns a fully-typed binding only when every required field is a string;
 * anything malformed is treated as absent.
 */
function parseOnchainBinding(value: unknown): OnchainBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const chain = obj.chain;
  const contract = obj.contract;
  const subject = obj.subject;
  if (
    typeof chain !== "string" ||
    typeof contract !== "string" ||
    typeof subject !== "string" ||
    !chain ||
    !contract ||
    !subject
  ) {
    return undefined;
  }
  return { chain, contract, subject };
}

/**
 * Read the optional `performanceLink` object from budget content, fully
 * typed. Anything malformed is treated as absent (the relay/sdk validate
 * at publication; a viewer never blocks on a bad stored ladder).
 */
function parsePerformanceLink(value: unknown): PerformanceLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const obj = value as Record<string, unknown>;
  const linkWindow = obj.window;
  if (
    linkWindow !== "day" &&
    linkWindow !== "week" &&
    linkWindow !== "month" &&
    linkWindow !== "epoch"
  ) {
    return undefined;
  }
  const tiersRaw = obj.tiers;
  if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) return undefined;
  const tiers: PerformanceTier[] = [];
  for (const raw of tiersRaw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const tier = raw as Record<string, unknown>;
    if (typeof tier.minAccepted !== "number" || !tier.limits) return undefined;
    tiers.push({
      minAccepted: tier.minAccepted,
      limits: tier.limits as BudgetLimits,
    });
  }
  const onViolation = obj.onViolation;
  if (
    onViolation !== "base" &&
    onViolation !== "require-approval" &&
    onViolation !== "revoke"
  ) {
    return undefined;
  }
  const threshold = obj.violationThreshold;
  const violationThreshold =
    threshold &&
    typeof threshold === "object" &&
    !Array.isArray(threshold) &&
    typeof (threshold as Record<string, unknown>).rejected === "number"
      ? { rejected: (threshold as Record<string, unknown>).rejected as number }
      : undefined;
  const dims = obj.dimensions;
  const dimensions = Array.isArray(dims)
    ? dims.filter((d): d is string => typeof d === "string")
    : undefined;
  return {
    window: linkWindow,
    ...(dimensions && dimensions.length > 0 ? { dimensions } : {}),
    tiers,
    onViolation,
    ...(violationThreshold ? { violationThreshold } : {}),
  };
}

export type OrgBudget = {
  eventId: string;
  /** Event author pubkey (lowercased) — the identity that published it. */
  author: string;
  dtag: string;
  subject: string;
  window: BudgetWindow;
  limits: BudgetLimits;
  onExceed: OnExceed;
  /** Present only when the spend ceiling is bound to an onchain allowance. */
  onchain?: OnchainBinding;
  /** Optional performance-linked autonomy ladder (NIP-ORG); absent = flat budget. */
  performanceLink?: PerformanceLink;
  createdAt: number;
  revoked: boolean;
};

export function eventToOrgBudget(event: RelayEvent): OrgBudget {
  const dtag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = parseContent(event);

  return {
    eventId: event.id,
    author: event.pubkey.toLowerCase(),
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
    onchain: parseOnchainBinding(content.onchain),
    performanceLink: parsePerformanceLink(content.performanceLink),
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
  /** Event author pubkey (lowercased) — the identity that published it. */
  author: string;
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
  /**
   * The parsed content snapshot rendered on screen — reviews copy this exact
   * version (never a click-time refetch), so an Accept always applies to the
   * record the reviewer saw.
   */
  content: Record<string, unknown>;
  /** The event tags rendered on screen — carried through the review republish. */
  tags: string[][];
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
    author: event.pubkey.toLowerCase(),
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
    content: { ...content },
    tags: event.tags.map((tag) => [...tag]),
  };
}

// ── Read models ─────────────────────────────────────────────────────────────

/**
 * NIP-ORG multi-reviewer resolution: reviews are republished under the
 * reviewer's own key with the same `d` tag, so parallel records for one
 * action exist by design. The canonical record per action is the newest
 * `created_at`; a tie breaks to the lowest event id (deterministic across
 * clients). Ledgers and review queues render only canonical records —
 * superseded versions must not double-count or resurrect verdicts.
 */
export function canonicalContributionRecords(
  records: ContributionRecord[],
): ContributionRecord[] {
  const byDtag = new Map<string, ContributionRecord>();
  for (const record of records) {
    if (!record.dtag) {
      // A record without an action id cannot be ordered; keep it visible
      // rather than silently dropping it.
      byDtag.set(`__event__${record.eventId}`, record);
      continue;
    }
    const current = byDtag.get(record.dtag);
    if (!current) {
      byDtag.set(record.dtag, record);
      continue;
    }
    const newer =
      record.createdAt > current.createdAt ||
      (record.createdAt === current.createdAt &&
        record.eventId < current.eventId);
    if (newer) byDtag.set(record.dtag, record);
  }
  return [...byDtag.values()];
}

export type OrgChart = {
  nodes: OrgNode[];
  grants: OrgGrant[];
  budgets: OrgBudget[];
};
