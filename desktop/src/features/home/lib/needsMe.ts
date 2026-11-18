import type {
  FeedItem,
  HomeFeedResponse,
  RelayEvent,
} from "@/shared/api/types";
import { truncatePubkey } from "@/shared/lib/pubkey";

/**
 * The "Needs me" surface: kind:46010 approval requests addressed to the
 * current user. The relay emits two shapes on this kind:
 *
 * - **Workflow approval requests** (workflow_sink.rs): relay-signed, plain-text
 *   content, tags `d` = approval token hash, `p` = the workflow owner who must
 *   approve, `h` = the owning channel.
 * - **NIP-ORG budget overrun requests** (budget_enforcement.rs): relay-signed,
 *   JSON content `{ type: "budget-exceeded", subject, counterType, window,
 *   limit }`, tags `d` = approval token hash, `p` = the budgeted agent. No
 *   `h` tag — these are community-level events.
 *
 * Both resolve through the same command surface: the approver signs a
 * kind:46030 (grant) or 46031 (deny) event whose `d` tag repeats the token
 * hash (see `crates/buzz-relay/src/handlers/command_executor.rs`). Access
 * control is relay-side; a non-approver publish is rejected on the OK frame
 * and the UI surfaces that rejection.
 */

// Mirrors buzz-core's KIND_APPROVAL_GRANT / KIND_APPROVAL_DENY. Kept local to
// avoid widening the shared constants surface in this change.
export const KIND_APPROVAL_GRANT = 46030;
export const KIND_APPROVAL_DENY = 46031;

export const KIND_APPROVAL_REQUEST = 46010;

/** Bounded read: never fetch more pending requests than this. */
export const NEEDS_ME_REQUEST_LIMIT = 50;

const BUDGET_EXCEEDED_TYPE = "budget-exceeded";

export type NeedsMeApprovalKind = "budget-overrun" | "workflow";

export type NeedsMeApproval = {
  id: string;
  /** sha256 approval token hash from the `d` tag — the resolution reference. */
  tokenHash: string;
  /**
   * Who the request is about: the budgeted agent pubkey (budget overrun) or
   * the workflow owner pubkey (workflow request).
   */
  subjectPubkey: string | null;
  kind: NeedsMeApprovalKind;
  /** Budget-only fields; null for workflow requests. */
  counterType: string | null;
  window: string | null;
  limit: number | null;
  createdAt: number;
};

export type NeedsMeResolution = {
  tokenHash: string;
  approved: boolean;
  resolverPubkey: string;
  eventId: string;
};

export type NeedsMeStatus = "pending" | "resolving" | "granted" | "denied";

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
  // Token hashes are lowercase hex sha256 digests.
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** The budgeted agent (budget overrun) or workflow owner (workflow request). */
function subjectPubkeyFromTags(tags: readonly (readonly string[])[]) {
  const value = tagValue(tags, "p");
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

type BudgetExceededContent = {
  subject: string | null;
  counterType: string | null;
  window: string | null;
  limit: number | null;
};

function parseBudgetExceededContent(
  content: string,
): BudgetExceededContent | null {
  const parsed = parseJsonObject(content);
  if (!parsed || stringField(parsed, "type") !== BUDGET_EXCEEDED_TYPE) {
    return null;
  }
  const limit = parsed.limit;
  return {
    subject: stringField(parsed, "subject"),
    counterType: stringField(parsed, "counterType"),
    window: stringField(parsed, "window"),
    limit: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
  };
}

/**
 * Map a kind:46010 event to a "needs me" approval. Returns null for events
 * missing the resolution reference — they can never be resolved and must not
 * render an action row.
 */
export function parseNeedsMeApproval(
  event: RelayEvent,
): NeedsMeApproval | null {
  if (event.kind !== KIND_APPROVAL_REQUEST) {
    return null;
  }
  const tokenHash = approvalTokenHashFromTags(event.tags);
  if (tokenHash === null) {
    return null;
  }
  const budget = parseBudgetExceededContent(event.content);
  return {
    id: event.id,
    tokenHash,
    subjectPubkey: budget?.subject ?? subjectPubkeyFromTags(event.tags),
    kind: budget ? "budget-overrun" : "workflow",
    counterType: budget?.counterType ?? null,
    window: budget?.window ?? null,
    limit: budget?.limit ?? null,
    createdAt: event.created_at,
  };
}

/**
 * Map a kind:46030/46031 command event to a resolution record. Returns null
 * for anything without a valid `d` reference.
 */
export function parseNeedsMeResolution(
  event: RelayEvent,
): NeedsMeResolution | null {
  if (event.kind !== KIND_APPROVAL_GRANT && event.kind !== KIND_APPROVAL_DENY) {
    return null;
  }
  const tokenHash = approvalTokenHashFromTags(event.tags);
  if (tokenHash === null) {
    return null;
  }
  return {
    tokenHash,
    approved: event.kind === KIND_APPROVAL_GRANT,
    resolverPubkey: event.pubkey,
    eventId: event.id,
  };
}

/** Compact the resolution list into token-hash → decision (last event wins). */
export function buildResolutionMap(
  resolutions: readonly NeedsMeResolution[],
): Map<string, NeedsMeResolution> {
  return new Map(
    resolutions.map((resolution) => [resolution.tokenHash, resolution]),
  );
}

/**
 * Status of one approval request. The locally-resolved set carries this
 * session's own published decisions (the resolution command events may not be
 * queryable by the subject), so a successful publish never resurrects the row.
 */
export function needsMeStatus(
  approval: NeedsMeApproval,
  resolutionByToken: ReadonlyMap<string, NeedsMeResolution>,
  locallyResolvedTokens: ReadonlySet<string> = new Set(),
): NeedsMeStatus {
  const local = locallyResolvedTokens.has(approval.tokenHash);
  if (local) {
    return "granted";
  }
  const resolution = resolutionByToken.get(approval.tokenHash);
  if (resolution) {
    return resolution.approved ? "granted" : "denied";
  }
  return "pending";
}

export type NeedsMePayloadRow = {
  label: string;
  /** Machine value (counter, window, limit, token hash) — render monospace. */
  value: string;
};

/**
 * Budget-overrun payload rows: the four numbers the relay emits on kind:46010
 * (`{ counterType, window, limit }` + the token-hash reference). Workflow
 * requests carry no structured payload.
 */
export function needsMePayloadRows(
  approval: NeedsMeApproval,
): NeedsMePayloadRow[] {
  if (approval.kind !== "budget-overrun") {
    return [];
  }
  const rows: NeedsMePayloadRow[] = [];
  if (approval.counterType !== null) {
    rows.push({ label: "Counter", value: approval.counterType });
  }
  if (approval.window !== null) {
    rows.push({ label: "Window", value: approval.window });
  }
  if (approval.limit !== null) {
    rows.push({ label: "Limit", value: String(approval.limit) });
  }
  rows.push({
    label: "Reference",
    value: truncateForPreview(approval.tokenHash),
  });
  return rows;
}

export function needsMeHeadline(approval: NeedsMeApproval): string {
  return approval.kind === "budget-overrun"
    ? "Budget approval needed"
    : "Approval requested";
}

export function needsMePreview(approval: NeedsMeApproval): string {
  if (approval.kind !== "budget-overrun") {
    return "A workflow is waiting for approval.";
  }
  const counter = approval.counterType ?? "spend";
  const windowPart = approval.window ? ` per ${approval.window}` : "";
  const limitPart =
    approval.limit !== null ? ` (limit ${approval.limit}${windowPart})` : "";
  const subjectPart = approval.subjectPubkey
    ? `Agent ${truncateForPreview(approval.subjectPubkey)} `
    : "An agent ";
  return `${subjectPart}hit its ${counter} budget${limitPart} and needs approval to continue.`;
}

/** Pending rows older than this get the amber aging treatment (WhatNeedsMe
 *  pattern: attention emphasis scales with wait time). */
export const NEEDS_ME_AGING_THRESHOLD_SECONDS = 24 * 60 * 60;

/**
 * True when a still-open request has been waiting longer than the aging
 * threshold. Resolved rows never age — the decision already happened.
 */
export function isNeedsMeAging(
  approval: Pick<NeedsMeApproval, "createdAt">,
  status: NeedsMeStatus,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): boolean {
  return (
    (status === "pending" || status === "resolving") &&
    nowSeconds - approval.createdAt > NEEDS_ME_AGING_THRESHOLD_SECONDS
  );
}

/** Callbacks the inbox rows use to resolve an approval request. */
export type NeedsMeApprovalActions = {
  resolve: (approval: NeedsMeApproval, approved: boolean) => void;
  /** Approval event ids with a resolution publish in flight. */
  resolvingEventIds: ReadonlySet<string>;
  /**
   * Per-token inline error from the last failed resolution publish. Approval
   * state is visible on screen, so failures render next to the buttons —
   * never a toast (docs/paperclip-ux-reference.md §1 contextual-feedback rule).
   */
  resolveErrors?: ReadonlyMap<string, string>;
  /** Clears a stale inline error so a retry starts clean. */
  clearResolveError?: (tokenHash: string) => void;
};

/** Inbox feed-item shape for a pending approval request. */
function needsMeFeedItem(event: RelayEvent): FeedItem {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    channelId: null,
    channelName: "",
    tags: event.tags,
    category: "needs_action",
  };
}

/**
 * Merge pending "needs me" requests into the home inbox feed's needs-action
 * section. Backend-fed copies of the same event win (they may carry channel
 * enrichment); requests already resolved (granted/denied) are filtered out of
 * BOTH sources so a resolved row never resurrects from the slower poll.
 */
export function mergeNeedsMeRequests(
  feed: HomeFeedResponse,
  pendingRequests: readonly RelayEvent[],
  resolvedEventIds: ReadonlySet<string>,
): HomeFeedResponse {
  const pendingIds = new Set(pendingRequests.map((event) => event.id));
  const needsAction = [
    ...feed.feed.needsAction.filter(
      (item) => !resolvedEventIds.has(item.id) && !pendingIds.has(item.id),
    ),
    ...pendingRequests
      .filter((event) => !resolvedEventIds.has(event.id))
      .map(needsMeFeedItem),
  ];
  return {
    ...feed,
    feed: {
      ...feed.feed,
      needsAction,
    },
  };
}

/**
 * Preview display form of a subject pubkey — the canonical compact form
 * (`truncatePubkey`), rendered as plain preview text.
 */
function truncateForPreview(pubkey: string): string {
  return truncatePubkey(pubkey);
}
