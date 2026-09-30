import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import {
  KIND_ORG_BUDGET,
  KIND_AGENT_TURN_METRIC,
} from "@/shared/constants/kinds";

import type { OrgBudget, BudgetWindow } from "../orgModels";
import { deleteAddressableEvents } from "../lib/orgDeletion";
import {
  buildOrgBudgetContent,
  isCommunityDefaultSubject,
  type OrgBudgetContentInput,
} from "../lib/budgetForm";
import {
  METRIC_FETCH_LIMIT,
  summarizeConsumption,
  type ConsumptionSummary,
} from "../lib/budgetConsumption";
import { ORG_STALE_TIME_MS, ORG_GC_TIME_MS, orgQueryKey } from "./shared";

// ── Budget mutations ───────────────────────────────────────────────────────

type OrgBudgetInput = OrgBudgetContentInput & {
  dtag: string;
};

async function publishOrgBudgetEvent(input: OrgBudgetInput): Promise<string> {
  // Throws locally on a subject the relay would reject (org node d-tags, empty).
  const content = buildOrgBudgetContent(input);
  const tags: string[][] = [["d", input.dtag]];
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
    enabled: subject.length > 0 && !isCommunityDefaultSubject(subject),
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
      // The community default covers every agent: turn metrics are keyed by
      // one agent's pubkey, so there is no single consumption to measure.
      summary:
        budget.subject && !isCommunityDefaultSubject(budget.subject)
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
