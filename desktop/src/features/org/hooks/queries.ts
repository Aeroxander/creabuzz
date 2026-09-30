import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_BUDGET,
  KIND_CONTRIBUTION_RECORD,
  KIND_APPROVAL_REQUEST,
  KIND_BUDGET_SPEND_RECEIPT,
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
  type ContributionRecord,
  type OrgChart,
} from "../orgModels";
import {
  ACTIVITY_FETCH_LIMIT,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
} from "../lib/dashboard";
import {
  ORG_STALE_TIME_MS,
  ORG_GC_TIME_MS,
  orgQueryKey,
  fetchOrgEvents,
} from "./shared";

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
