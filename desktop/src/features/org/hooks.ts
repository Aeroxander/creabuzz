import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { invokeTauri, signRelayEvent } from "@/shared/api/tauri";
import {
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
  KIND_AGENT_TURN_METRIC,
  KIND_AGENT_TASK,
  KIND_AGENT_CAPABILITIES,
  KIND_APPROVAL_REQUEST,
  KIND_BUDGET_SPEND_RECEIPT,
  KIND_AGENT_WIKI_PAGE,
} from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

import {
  eventToOrgNode,
  eventToOrgGrant,
  eventToOrgBudget,
  canonicalContributionRecords,
  eventToContributionRecord,
  type OrgNode,
  type OrgGrant,
  type OrgBudget,
  type BudgetWindow,
  type ContributionRecord,
  type ReviewStatus,
  type OrgChart,
} from "./orgModels";
import { deleteAddressableEvents } from "./lib/orgDeletion";
import {
  METRIC_FETCH_LIMIT,
  summarizeConsumption,
  type ConsumptionSummary,
} from "./lib/budgetConsumption";
import {
  LIVENESS_FETCH_LIMIT,
  type LivenessEventLike,
} from "./lib/nodeLiveness";
import {
  ACTIVITY_FETCH_LIMIT,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
} from "./lib/dashboard";
import { AUDIT_EVENT_KINDS, AUDIT_FETCH_LIMIT } from "./lib/audit";
import {
  AGENT_WIKI_FETCH_LIMIT,
  newestAgentWikiPages,
  type AgentWikiPage,
} from "./lib/agentWiki";

// ── Query keys ──────────────────────────────────────────────────────────────

export const orgQueryKey = ["org"] as const;

// ── Stale/GC times ─────────────────────────────────────────────────────────

const ORG_STALE_TIME_MS = 60_000; // 1 minute
const ORG_GC_TIME_MS = 5 * 60_000; // 5 minutes

// ── Fetch helpers ───────────────────────────────────────────────────────────

// NOTE: relayClient.fetchEvents(filter) does not accept an AbortSignal (the
// RelaySubscriptionFilter has no signal field), so React Query's cancellation
// signal cannot be forwarded yet. The parameter is kept so the call sites
// already match a future fetchEvents(filter, { signal }) upgrade.
async function fetchOrgEvents(
  kinds: number[],
  _signal?: AbortSignal,
): Promise<RelayEvent[]> {
  return relayClient.fetchEvents({
    kinds,
    limit: 500,
  });
}

async function fetchOrgNodes(signal?: AbortSignal): Promise<OrgNode[]> {
  const events = await fetchOrgEvents([KIND_ORG_NODE], signal);
  return events.map(eventToOrgNode).filter((n) => !n.revoked);
}

/**
 * Grants are fetched WITHOUT dropping revoked/expired events: the delegation
 * surface keeps revocation and expiry as visible history (the "Revoked &
 * expired" curtain in OrgGrantChainView). Consumers split by lifecycle where
 * they need the active set only — see lib/grantCurtain.ts.
 */
async function fetchOrgGrants(signal?: AbortSignal): Promise<OrgGrant[]> {
  const events = await fetchOrgEvents([KIND_ORG_GRANT], signal);
  return events.map(eventToOrgGrant);
}

async function fetchOrgBudgets(signal?: AbortSignal): Promise<OrgBudget[]> {
  const events = await fetchOrgEvents([KIND_ORG_BUDGET], signal);
  return events.map(eventToOrgBudget).filter((b) => !b.revoked);
}

async function fetchContributionRecords(
  signal?: AbortSignal,
): Promise<ContributionRecord[]> {
  const events = await fetchOrgEvents([KIND_CONTRIBUTION_RECORD], signal);
  // Multi-reviewer resolution (NIP-ORG § Contribution record review):
  // collapse reviewer forks to the canonical newest record per action id.
  return canonicalContributionRecords(events.map(eventToContributionRecord));
}

async function fetchOrgChart(signal?: AbortSignal): Promise<OrgChart> {
  const [nodes, grants, budgets] = await Promise.all([
    fetchOrgNodes(signal),
    fetchOrgGrants(signal),
    fetchOrgBudgets(signal),
  ]);
  return { nodes, grants, budgets };
}

// ── React Query hooks ───────────────────────────────────────────────────────

export function useOrgChartQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "chart"],
    queryFn: ({ signal }) => fetchOrgChart(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

export function useOrgNodesQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "nodes"],
    queryFn: ({ signal }) => fetchOrgNodes(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

export function useOrgGrantsQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "grants"],
    queryFn: ({ signal }) => fetchOrgGrants(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

export function useOrgBudgetsQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "budgets"],
    queryFn: ({ signal }) => fetchOrgBudgets(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

export function useContributionRecordsQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "contributions"],
    queryFn: ({ signal }) => fetchContributionRecords(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Agent tasks (kind:44011) — evidence picker source ──────────────────────

export type AgentTaskRef = {
  eventId: string;
  dtag: string;
  title: string;
  status?: string;
  createdAt: number;
};

async function fetchAgentTasks(signal?: AbortSignal): Promise<AgentTaskRef[]> {
  const events = await fetchOrgEvents([KIND_AGENT_TASK], signal);
  return events.map((event) => {
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(event.content);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Malformed content — fall back to the event id as the title.
    }
    return {
      eventId: event.id,
      dtag: event.tags.find((t) => t[0] === "d")?.[1] ?? "",
      title: (typeof parsed.title === "string" && parsed.title) || event.id,
      status:
        typeof parsed.status === "string" && parsed.status
          ? parsed.status
          : undefined,
      createdAt: event.created_at,
    };
  });
}

export function useAgentTasksQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "agent-tasks"],
    queryFn: ({ signal }) => fetchAgentTasks(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Agent liveness (kinds:44010 capabilities + 44200 turn metrics) ────────

/**
 * Newest liveness signal per agent identity, bounded. Heartbeat-style rows
 * flood history, so the read pulls a capped page per kind — the newest
 * signals are what liveness needs, and a truncated page still has them.
 * Derivation (thresholds + per-seat newest) lives in lib/nodeLiveness.ts;
 * this hook only fetches.
 */
async function fetchLivenessEvents(
  _signal?: AbortSignal,
): Promise<LivenessEventLike[]> {
  const [capabilities, metrics] = await Promise.all([
    relayClient.fetchEvents({
      kinds: [KIND_AGENT_CAPABILITIES],
      limit: LIVENESS_FETCH_LIMIT,
    }),
    relayClient.fetchEvents({
      kinds: [KIND_AGENT_TURN_METRIC],
      limit: LIVENESS_FETCH_LIMIT,
    }),
  ]);
  return [...capabilities, ...metrics];
}

export function useAgentLivenessQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "liveness"],
    queryFn: ({ signal }) => fetchLivenessEvents(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Dashboard activity extras (kind:37014 receipts + 46_0xx approvals) ────

/**
 * Receipts and approval traffic for the dashboard feed. Org kinds 37010–37013
 * are covered by the org chart query (models), so this fetch stays bounded to
 * the kinds with no model layer yet.
 */
async function fetchActivityExtras(
  _signal?: AbortSignal,
): Promise<RelayEvent[]> {
  return relayClient.fetchEvents({
    kinds: [
      KIND_BUDGET_SPEND_RECEIPT,
      KIND_APPROVAL_REQUEST,
      KIND_APPROVAL_GRANT,
      KIND_APPROVAL_DENY,
    ],
    limit: ACTIVITY_FETCH_LIMIT,
  });
}

export function useOrgActivityExtrasQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "activity-extras"],
    queryFn: ({ signal }) => fetchActivityExtras(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Audit log (the evidence spine) ────────────────────────────────────────

/**
 * Raw structural org events (kinds 37010–37014 + 46010/46030/46031), newest
 * first in the view layer. The event stream IS the evidence — every
 * structural change is a signed, community-level event on the relay, and
 * every revision is kept (no LWW folding): an audit view shows history, not
 * the current head. Bounded at AUDIT_FETCH_LIMIT; the caller surfaces the
 * truncation honestly.
 *
 * NOTE (future upgrade): the relay also maintains a hash-chain audit log
 * with an operator-side verification path (buzz-admin). Exact cryptographic
 * chain verification is that operator view's job; this query provides the
 * community-visible presence evidence.
 */
async function fetchAuditEvents(_signal?: AbortSignal): Promise<RelayEvent[]> {
  const events = await relayClient.fetchEvents({
    kinds: [...AUDIT_EVENT_KINDS],
    limit: AUDIT_FETCH_LIMIT,
  });
  // Newest first so the view can rely on page order even before rendering.
  return events.sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
}

export function useOrgAuditQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "audit"],
    queryFn: ({ signal }) => fetchAuditEvents(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────

type OrgNodeInput = {
  dtag: string;
  name: string;
  kind: "role" | "team" | "agent_seat";
  parent?: string;
  holders?: string[];
  agentSeats?: string[];
};

async function publishOrgNodeEvent(input: OrgNodeInput): Promise<string> {
  const tags: string[][] = [["d", input.dtag]];
  if (input.holders) {
    for (const h of input.holders) tags.push(["p", h]);
  }
  if (input.agentSeats) {
    for (const a of input.agentSeats) tags.push(["p", a]);
  }
  const content = JSON.stringify({
    v: 1,
    name: input.name,
    kind: input.kind,
    parent: input.parent,
    holders: input.holders ?? [],
    agentSeats: input.agentSeats ?? [],
    scope: {},
  });
  const event = await signRelayEvent({ kind: KIND_ORG_NODE, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out creating org node.",
    "Failed to create org node.",
  );
  return event.id;
}

async function publishOrgNodeDeletion(dtag: string): Promise<string> {
  await deleteAddressableEvents(
    {
      kind: KIND_ORG_NODE,
      dtag,
      label: "org node",
      timeoutMessage: "Timed out deleting org node.",
      failureMessage: "Failed to delete org node.",
    },
    {
      fetchEvents: relayClient.fetchEvents.bind(relayClient),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
      publishEvent: relayClient.publishEvent.bind(relayClient),
      signEvent: signRelayEvent,
    },
  );
  return dtag;
}

export function useCreateOrgNodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgNodeEvent,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "nodes"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

export function useDeleteOrgNodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgNodeDeletion,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "nodes"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

type OrgGrantInput = {
  dtag: string;
  grantee: string;
  via: string;
  verbs: string[];
  parentGrant?: string;
  expires?: number;
};

async function publishOrgGrantEvent(input: OrgGrantInput): Promise<string> {
  const tags: string[][] = [
    ["d", input.dtag],
    ["p", input.grantee],
  ];
  const content = JSON.stringify({
    v: 1,
    issuer: "",
    grantee: input.grantee,
    via: input.via,
    verbs: input.verbs,
    parentGrant: input.parentGrant,
    expires: input.expires,
    revoked: false,
  });
  const event = await signRelayEvent({ kind: KIND_ORG_GRANT, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out creating grant.",
    "Failed to create grant.",
  );
  return event.id;
}

async function publishOrgGrantRevocation(dtag: string): Promise<string> {
  const tags: string[][] = [["d", dtag]];
  const content = JSON.stringify({ revoked: true });
  const event = await signRelayEvent({ kind: KIND_ORG_GRANT, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out revoking grant.",
    "Failed to revoke grant.",
  );
  return event.id;
}

export function useCreateOrgGrantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgGrantEvent,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "grants"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

export function useRevokeOrgGrantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgGrantRevocation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "grants"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

type OrgBudgetInput = {
  dtag: string;
  subject: string;
  window: "epoch" | "day" | "week" | "month";
  spendAmount?: number;
  runs?: number;
  taskCreate?: number;
  taskApprove?: number;
};

async function publishOrgBudgetEvent(input: OrgBudgetInput): Promise<string> {
  const limits: Record<string, unknown> = {};
  if (input.spendAmount != null) {
    limits.spend = { amount: input.spendAmount, unit: "usd-cents" };
  }
  if (input.runs != null) {
    limits.runs = input.runs;
  }
  if (input.taskCreate != null || input.taskApprove != null) {
    limits.tasks = {
      ...(input.taskCreate != null ? { create: input.taskCreate } : {}),
      ...(input.taskApprove != null ? { approve: input.taskApprove } : {}),
    };
  }
  const tags: string[][] = [["d", input.dtag]];
  const content = JSON.stringify({
    v: 1,
    subject: input.subject,
    window: input.window,
    limits,
    onExceed: "require-approval",
  });
  const event = await signRelayEvent({ kind: KIND_ORG_BUDGET, content, tags });
  await relayClient.publishEvent(
    event,
    "Timed out creating budget.",
    "Failed to create budget.",
  );
  return event.id;
}

async function publishOrgBudgetDeletion(dtag: string): Promise<string> {
  await deleteAddressableEvents(
    {
      kind: KIND_ORG_BUDGET,
      dtag,
      label: "org budget",
      timeoutMessage: "Timed out deleting budget.",
      failureMessage: "Failed to delete budget.",
    },
    {
      fetchEvents: relayClient.fetchEvents.bind(relayClient),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
      publishEvent: relayClient.publishEvent.bind(relayClient),
      signEvent: signRelayEvent,
    },
  );
  return dtag;
}

export function useCreateOrgBudgetMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgBudgetEvent,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "budgets"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

export function useDeleteOrgBudgetMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishOrgBudgetDeletion,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "budgets"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

// ── Budget consumption (Phase 2) ───────────────────────────────────────────

async function fetchBudgetConsumption(
  subject: string,
  window: BudgetWindow,
  runsLimit?: number,
): Promise<ConsumptionSummary> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_AGENT_TURN_METRIC],
    "#p": [subject],
    limit: METRIC_FETCH_LIMIT,
  });
  return summarizeConsumption(events, {
    window,
    runsLimit,
    nowSeconds: Math.floor(Date.now() / 1_000),
    // The relay returned a full page: the real count may be higher, so the
    // UI must show a floor, not a percentage computed from a truncated set.
    hitFetchLimit: events.length >= METRIC_FETCH_LIMIT,
  });
}

export function useBudgetConsumptionQuery(
  subject: string,
  window: BudgetWindow,
  runsLimit?: number,
) {
  return useQuery({
    queryKey: [
      ...orgQueryKey,
      "consumption",
      subject,
      window,
      runsLimit ?? null,
    ],
    queryFn: () => fetchBudgetConsumption(subject, window, runsLimit),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled: subject.length > 0,
  });
}

export type BudgetUtilizationEntry = {
  budget: OrgBudget;
  /** Consumption summary for the budget, or null when it has no subject. */
  summary: ConsumptionSummary | null;
};

async function fetchBudgetUtilizations(
  budgets: OrgBudget[],
): Promise<BudgetUtilizationEntry[]> {
  return Promise.all(
    budgets.map(async (budget) => ({
      budget,
      summary: budget.subject
        ? await fetchBudgetConsumption(
            budget.subject,
            budget.window,
            budget.limits.runs,
          )
        : null,
    })),
  );
}

/**
 * Batched per-budget consumption for the org metric row. One query over all
 * active budgets (the per-budget hook above stays for the budget cards), so
 * the summary row does not mount a variable number of hook calls.
 */
export function useBudgetUtilizationsQuery(budgets: OrgBudget[]) {
  const key = budgets
    .map((b) => `${b.dtag}:${b.subject}:${b.window}:${b.limits.runs ?? "-"}`)
    .join("|");
  return useQuery({
    queryKey: [...orgQueryKey, "budget-utilizations", key],
    queryFn: () => fetchBudgetUtilizations(budgets),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled: budgets.length > 0,
  });
}

// ── Contribution review (Phase 3) ──────────────────────────────────────────

type ReviewUpdateInput = {
  dtag: string;
  reviewStatus: ReviewStatus;
  appealNote?: string;
};

/**
 * Republish a kind:37013 record with the same `d` tag, copying every prior
 * field and updating `reviewStatus` (NIP-33 LWW picks the newest write).
 * The relay-side reviewer grant check is future work; any signer may review
 * for now and the UI labels reviewers as unverified.
 */
async function republishContributionReview(
  input: ReviewUpdateInput,
): Promise<string> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_CONTRIBUTION_RECORD],
    "#d": [input.dtag],
    limit: 500,
  });
  if (events.length === 0) {
    throw new Error(`Contribution record "${input.dtag}" not found.`);
  }
  const current = events.reduce((newest, event) =>
    event.created_at > newest.created_at ? event : newest,
  );

  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(current.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    content = parsed as Record<string, unknown>;
  } catch {
    content = {};
  }

  content.reviewStatus = input.reviewStatus;
  if (input.reviewStatus === "appealed") {
    const history = Array.isArray(content.appealHistory)
      ? (content.appealHistory as unknown[])
      : [];
    content.appealHistory = [
      ...history,
      {
        status: "appealed",
        at: Math.floor(Date.now() / 1_000),
        ...(input.appealNote ? { note: input.appealNote } : {}),
      },
    ];
  }

  const event = await signRelayEvent({
    kind: KIND_CONTRIBUTION_RECORD,
    content: JSON.stringify(content),
    tags: current.tags,
  });
  await relayClient.publishEvent(
    event,
    "Timed out updating contribution review.",
    "Failed to update contribution review.",
  );
  return event.id;
}

export function useUpdateContributionReviewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: republishContributionReview,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "contributions"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}

// ── Ragequit / exit (dev-first, NIP-ORG onchain binding) ──────────────────

/** Result of a settled ragequit (from the `org_ragequit` Tauri command). */
export type OrgRagequitResult = {
  txHash: string;
  dao: string;
  sharesBurned: string;
  sharesRemaining: string;
  lootRemaining: string;
};

/** Value-layer env presence (hint-only — no gates). */
export type OrgEvmStatus = {
  rpcConfigured: boolean;
  spenderConfigured: boolean;
};

/**
 * Whether the value-layer env (BUZZ_EVM_RPC_URL / BUZZ_SPENDER_KEY) is
 * configured. Read-only; drives the "configure EVM key" hint vs. the exit
 * action. DEV mapping: the configured spender key IS the shareholder.
 */
export function useOrgEvmStatusQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "evm-status"],
    queryFn: () => invokeTauri<OrgEvmStatus>("org_evm_status"),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

/**
 * Ragequit the bound DAO from the configured value-layer spender key (the
 * DEV shareholder mapping). On settlement the org queries invalidate — the
 * binding's own Nostr record does not change, but dashboards reading
 * budgets/consumption should refresh. Shares are decimal strings (uint256).
 */
export function useOrgRagequitMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      dao: string;
      shares?: string;
      tokens?: string[];
    }): Promise<OrgRagequitResult> =>
      invokeTauri<OrgRagequitResult>("org_ragequit", {
        dao: input.dao,
        shares: input.shares ?? null,
        tokens: input.tokens ?? [],
      }),
    onSuccess: async () => {
      for (const leaf of ["chart", "nodes", "grants", "budgets", "audit"]) {
        await queryClient.invalidateQueries({
          queryKey: [...orgQueryKey, leaf],
        });
      }
    },
  });
}

// ── Contribution classifier (buzz org contribute classify) ────────────────
//
// The desktop spawns the bundled `buzz` sidecar and returns structured
// results; the classifier API key never crosses the IPC boundary (it is
// passed only to the child process environment in Rust).

export type OrgClassifyResult = {
  mode: "preview" | "published";
  taskEventId: string;
  /** Validated draft content (preview mode only). */
  draft?: Record<string, unknown>;
  /** Published record event id (publish mode only). */
  eventId?: string;
};

export type OrgClassifyBatchTask = {
  status: "ok" | "skip" | "fail";
  detail: string;
  line: string;
};

export type OrgClassifyBatchResult = {
  ok: number;
  skipped: number;
  failed: number;
  tasks: OrgClassifyBatchTask[];
};

/** Single-task draft: preview (no confirm needed) or publish (confirm in UI). */
export function useOrgClassifyTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      taskEventId: string;
      publish: boolean;
    }): Promise<OrgClassifyResult> =>
      invokeTauri<OrgClassifyResult>("org_classify_task", {
        taskEventId: input.taskEventId,
        publish: input.publish,
      }),
    onSuccess: () => {
      // A published pending record should show up in the Contributions tab.
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "contributions"],
      });
    },
  });
}

// ── Agent Wiki (kind:44002, read-only) ──────────────────────────────────────

async function fetchAgentWikiPages(
  _signal?: AbortSignal,
): Promise<AgentWikiPage[]> {
  // Bounded at the wiki's own limit, not fetchOrgEvents' 500-event cap.
  // fetchEvents does not take a signal yet (see the NOTE on fetchOrgEvents).
  const events = await relayClient.fetchEvents({
    kinds: [KIND_AGENT_WIKI_PAGE],
    limit: AGENT_WIKI_FETCH_LIMIT,
  });
  return newestAgentWikiPages(events);
}

/**
 * Fetch a single wiki page head by its full d tag ("default/standup").
 * Bounded and folded by the same read-side LWW as the list query.
 */
export async function fetchAgentWikiPage(
  d: string,
  _signal?: AbortSignal,
): Promise<AgentWikiPage | null> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_AGENT_WIKI_PAGE],
    "#d": [d],
    limit: AGENT_WIKI_FETCH_LIMIT,
  });
  return newestAgentWikiPages(events)[0] ?? null;
}

/** All wiki page heads, newest-first, folded per (pubkey, d) then per d. */
export function useAgentWikiPagesQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "agent-wiki"],
    queryFn: ({ signal }) => fetchAgentWikiPages(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

/** Batch: draft records for all done tasks that lack one (one LLM call each). */
export function useOrgClassifyAllDoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limit?: number): Promise<OrgClassifyBatchResult> =>
      invokeTauri<OrgClassifyBatchResult>("org_classify_all_done", {
        limit: limit ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "contributions"],
      });
    },
  });
}
