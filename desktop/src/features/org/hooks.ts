import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import {
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
  KIND_AGENT_TURN_METRIC,
  KIND_AGENT_TASK,
} from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

import {
  eventToOrgNode,
  eventToOrgGrant,
  eventToOrgBudget,
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
  return events.map(eventToContributionRecord);
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
