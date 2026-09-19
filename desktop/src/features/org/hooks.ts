import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import {
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
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
  type ContributionRecord,
  type OrgChart,
} from "./orgModels";
import { deleteAddressableEvents } from "./lib/orgDeletion";

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

async function fetchOrgGrants(signal?: AbortSignal): Promise<OrgGrant[]> {
  const events = await fetchOrgEvents([KIND_ORG_GRANT], signal);
  return events.map(eventToOrgGrant).filter((g) => !g.revoked);
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
