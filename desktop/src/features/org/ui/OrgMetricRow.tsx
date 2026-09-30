import * as React from "react";

import { MetricCard } from "@/shared/ui/MetricCard";
import { UtilizationBar } from "@/shared/ui/UtilizationBar";
import {
  summarizeUtilizations,
  utilizationPercentage,
} from "@/shared/ui/utilizationThresholds";

import { useBudgetUtilizationsQuery } from "../hooks";
import { METRIC_FETCH_LIMIT } from "../lib/budgetConsumption";
import { pluralize } from "../lib/format";
import { orgChartSummary } from "../lib/tree";
import type { OrgChart } from "../orgModels";

type OrgMetricRowProps = {
  data: OrgChart;
  /**
   * Where "needs attention" leads: scrolls to the budgets section on the
   * Chart tab, or switches to the Chart tab from the Dashboard. A real
   * affordance, never fake navigation.
   */
  onFocusBudgets: () => void;
};

/**
 * The four org metric cards (paperclip-ux-reference.md §2.1): Nodes, Active
 * grants, Budgets (count + worst utilization bar), and Needs attention.
 * Shared by the Chart and Dashboard tabs so the numbers derive from one
 * implementation — this is the single source, not a per-tab copy.
 */
export function OrgMetricRow({ data, onFocusBudgets }: OrgMetricRowProps) {
  const summary = orgChartSummary(data.nodes, data.grants, data.budgets);
  const activeBudgets = React.useMemo(
    () => data.budgets.filter((b) => !b.revoked),
    [data.budgets],
  );
  const utilizations = useBudgetUtilizationsQuery(activeBudgets);
  const entries = utilizations.data ?? [];

  const inputs = entries.map((entry) => {
    if (!entry.summary) {
      return { flagged: false, percentage: null, truncated: false };
    }
    const { consumed, limit, truncated } = entry.summary;
    return {
      flagged: typeof limit === "number" && limit === 0 && consumed > 0,
      percentage: utilizationPercentage(consumed, limit),
      truncated,
    };
  });
  const { worstIndex, attentionCount } = summarizeUtilizations(inputs);

  const worst = worstIndex !== null ? entries[worstIndex] : undefined;
  const anyTruncated = entries.some((entry) => entry.summary?.truncated);
  const floorEntry = anyTruncated
    ? entries.find((entry) => entry.summary?.truncated)
    : undefined;

  const worstSummary = worst?.summary;
  const worstHasCeiling =
    typeof worstSummary?.limit === "number" && (worstSummary?.limit ?? 0) > 0;

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <MetricCard
        label="Nodes"
        testId="org-metric-nodes"
        value={summary.nodeCount}
      />
      <MetricCard
        description={pluralize(summary.agentSeatCount, "agent seat")}
        label="Active grants"
        testId="org-metric-grants"
        value={summary.grantCount}
      />
      <MetricCard
        description={
          utilizations.isPending
            ? "checking usage…"
            : activeBudgets.length === 0
              ? undefined
              : worstSummary
                ? undefined
                : "no usage data"
        }
        label="Budgets"
        testId="org-metric-budgets"
        value={activeBudgets.length}
      >
        {worst && worstSummary && (
          <UtilizationBar
            caption={`worst of ${pluralize(activeBudgets.length, "budget")}`}
            className="mt-1.5 px-1"
            consumed={worstSummary.consumed}
            label="Worst budget"
            limit={worstHasCeiling ? worstSummary.limit : null}
            readout={
              worstSummary.truncated
                ? undefined
                : worstHasCeiling
                  ? `${worstSummary.consumed} / ${worstSummary.limit} runs`
                  : `${worstSummary.consumed} runs`
            }
            truncated={worstSummary.truncated}
          />
        )}
        {!worst && floorEntry?.summary && (
          <UtilizationBar
            className="mt-1.5 px-1"
            consumed={floorEntry.summary.consumed}
            floor={METRIC_FETCH_LIMIT}
            label={`Budget usage floor (${floorEntry.budget.subject || floorEntry.budget.dtag})`}
            truncated
          />
        )}
      </MetricCard>
      <MetricCard
        description={
          activeBudgets.length === 0
            ? "no budgets to watch"
            : "budgets at 70%+ · truncated counts marked"
        }
        label="Needs attention"
        onClick={activeBudgets.length > 0 ? onFocusBudgets : undefined}
        testId="org-metric-needs-attention"
        value={attentionCount}
      />
    </div>
  );
}
