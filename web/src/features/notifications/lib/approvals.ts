/**
 * Approval requests ("needs me"): kind:46010 events addressed to the current
 * user. The server emits two shapes on this kind:
 *
 * - Workflow approval requests: relay-signed, plain-text content, tags
 *   `d` = approval token hash, `p` = the workflow owner who must approve.
 * - Budget overrun requests: relay-signed, JSON content
 *   `{ type: "budget-exceeded", subject, counterType, window, limit }`,
 *   tags `d` = approval token hash, `p` = the budgeted agent.
 *
 * Both resolve through the same command surface: the approver signs a
 * kind:46030 (grant) or 46031 (deny) event whose `d` tag repeats the token
 * hash. Access control is server-side; a non-approver publish is rejected on
 * the OK frame and the UI surfaces that rejection with a retry.
 */

// Mirrors the server's approval kinds. Kept local to the web client.
export const KIND_APPROVAL_REQUEST = 46010;
export const KIND_APPROVAL_GRANT = 46030;
export const KIND_APPROVAL_DENY = 46031;

/** Bounded read: never fetch more pending requests than this. */
export const APPROVALS_REQUEST_LIMIT = 50;

const BUDGET_EXCEEDED_TYPE = "budget-exceeded";

export type ApprovalRequestKind = "budget-overrun" | "workflow";

export type ApprovalRequest = {
  id: string;
  /** sha256 approval token hash from the `d` tag — the resolution reference. */
  tokenHash: string;
  /** Who the request is about: the budgeted agent or the workflow owner. */
  subjectPubkey: string | null;
  kind: ApprovalRequestKind;
  /** Budget-only fields; null for workflow requests. */
  counterType: string | null;
  window: string | null;
  limit: number | null;
  createdAt: number;
};

export type ApprovalResolution = {
  tokenHash: string;
  approved: boolean;
  resolverPubkey: string;
  eventId: string;
};

export type ApprovalStatus = "pending" | "resolving" | "granted" | "denied";

type NostrEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
};

/** Defensive JSON parse: event content is untrusted display text. */
function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain-text content (workflow requests) or malformed JSON.
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function tagValue(tags: readonly (readonly string[])[], name: string) {
  return tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

/** The approval token hash every resolution references (`d` tag). */
export function approvalTokenHashFromTags(
  tags: readonly (readonly string[])[],
): string | null {
  const value = tagValue(tags, "d");
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function subjectPubkeyFromTags(
  tags: readonly (readonly string[])[],
  content: string,
) {
  const parsed = parseJsonObject(content);
  const fromContent =
    parsed && stringField(parsed, "type") === BUDGET_EXCEEDED_TYPE
      ? stringField(parsed, "subject")
      : null;
  if (fromContent && /^[0-9a-f]{64}$/.test(fromContent)) return fromContent;
  const value = tagValue(tags, "p");
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/**
 * Map a kind:46010 event to an approval request. Returns null for events
 * missing the resolution reference — they can never be resolved and must not
 * render an action row.
 */
export function parseApprovalRequest(
  event: NostrEventLike,
): ApprovalRequest | null {
  if (event.kind !== KIND_APPROVAL_REQUEST) return null;
  const tokenHash = approvalTokenHashFromTags(event.tags);
  if (tokenHash === null) return null;
  const parsed = parseJsonObject(event.content);
  const isBudget =
    parsed !== null && stringField(parsed, "type") === BUDGET_EXCEEDED_TYPE;
  const limit = parsed?.limit;
  return {
    id: event.id,
    tokenHash,
    subjectPubkey: subjectPubkeyFromTags(event.tags, event.content),
    kind: isBudget ? "budget-overrun" : "workflow",
    counterType: isBudget ? stringField(parsed, "counterType") : null,
    window: isBudget ? stringField(parsed, "window") : null,
    limit:
      isBudget && typeof limit === "number" && Number.isFinite(limit)
        ? limit
        : null,
    createdAt: event.created_at,
  };
}

/**
 * Map a kind:46030/46031 command event to a resolution record. Returns null
 * for anything without a valid `d` reference.
 */
export function parseApprovalResolution(
  event: NostrEventLike,
): ApprovalResolution | null {
  if (event.kind !== KIND_APPROVAL_GRANT && event.kind !== KIND_APPROVAL_DENY) {
    return null;
  }
  const tokenHash = approvalTokenHashFromTags(event.tags);
  if (tokenHash === null) return null;
  return {
    tokenHash,
    approved: event.kind === KIND_APPROVAL_GRANT,
    resolverPubkey: event.pubkey,
    eventId: event.id,
  };
}

/** Compact the resolution list into token-hash → decision (last event wins). */
export function buildResolutionMap(
  resolutions: readonly ApprovalResolution[],
): Map<string, ApprovalResolution> {
  return new Map(
    resolutions.map((resolution) => [resolution.tokenHash, resolution]),
  );
}

/**
 * Status of one request. The locally-resolved set carries this session's own
 * published decisions (resolution events may not be queryable by the subject),
 * so a successful publish never resurrects the row.
 */
export function approvalStatus(
  request: ApprovalRequest,
  resolutionByToken: ReadonlyMap<string, ApprovalResolution>,
  locallyResolvedTokens: ReadonlySet<string> = new Set(),
): ApprovalStatus {
  if (locallyResolvedTokens.has(request.tokenHash)) return "granted";
  const resolution = resolutionByToken.get(request.tokenHash);
  if (resolution) return resolution.approved ? "granted" : "denied";
  return "pending";
}

export type ApprovalRowDetail = {
  label: string;
  value: string;
};

/** Who/what/why rows: subject, counter, window, limit. */
export function approvalDetailRows(
  request: ApprovalRequest,
  resolveName: (pubkey: string) => string,
): ApprovalRowDetail[] {
  const rows: ApprovalRowDetail[] = [];
  if (request.subjectPubkey) {
    rows.push({ label: "Agent", value: resolveName(request.subjectPubkey) });
  }
  if (request.counterType !== null) {
    rows.push({ label: "Counter", value: request.counterType });
  }
  if (request.window !== null) {
    rows.push({ label: "Window", value: request.window });
  }
  if (request.limit !== null) {
    rows.push({ label: "Limit", value: String(request.limit) });
  }
  return rows;
}

export function approvalHeadline(request: ApprovalRequest): string {
  return request.kind === "budget-overrun"
    ? "Budget approval needed"
    : "Approval requested";
}

export function approvalPreview(request: ApprovalRequest): string {
  if (request.kind !== "budget-overrun") {
    return "A workflow is waiting for approval.";
  }
  const counter = request.counterType ?? "spend";
  const windowPart = request.window ? ` per ${request.window}` : "";
  const limitPart =
    request.limit !== null ? ` (limit ${request.limit}${windowPart})` : "";
  return `An agent hit its ${counter} budget${limitPart} and needs approval to continue.`;
}
