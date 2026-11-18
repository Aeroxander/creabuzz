import { UtilizationBar } from "@/shared/ui/UtilizationBar";
import { useBudgetConsumptionQuery } from "../hooks";
import { METRIC_FETCH_LIMIT } from "../lib/budgetConsumption";
import type { OrgBudget } from "../orgModels";

type OrgBudgetConsumptionProps = {
  budget: OrgBudget;
};

const RESET_HINT: Record<OrgBudget["window"], string> = {
  day: "resets daily",
  week: "resets weekly",
  month: "resets monthly",
  epoch: "all-time window",
};

/**
 * Thin consumer of the shared UtilizationBar (thresholds + honesty rule live
 * there). Runs consumed inside the budget's window come from kind:44200
 * agent turn metrics; when the metric fetch hits its cap the count is a
 * floor, so UtilizationBar shows ">{METRIC_FETCH_LIMIT} … floor" instead of
 * a wrong percentage.
 */
export function OrgBudgetConsumption({ budget }: OrgBudgetConsumptionProps) {
  const query = useBudgetConsumptionQuery(
    budget.subject,
    budget.window,
    budget.limits.runs,
  );
  const label = `Agent turn usage for ${budget.subject || budget.dtag}`;

  if (query.isPending) {
    return (
      <p className="mt-1.5 text-2xs text-muted-foreground">Checking usage…</p>
    );
  }

  if (query.isError || !query.data) {
    return (
      <p className="mt-1.5 text-2xs text-muted-foreground">Usage unavailable</p>
    );
  }

  const { consumed, limit, truncated } = query.data;
  const hasCeiling = typeof limit === "number";

  return (
    <div className="mt-1.5">
      <UtilizationBar
        caption={
          hasCeiling
            ? RESET_HINT[budget.window]
            : `no runs ceiling · ${RESET_HINT[budget.window]}`
        }
        consumed={consumed}
        floor={METRIC_FETCH_LIMIT}
        label={label}
        limit={hasCeiling ? limit : null}
        readout={
          truncated
            ? undefined
            : hasCeiling
              ? `${consumed} / ${limit} runs used`
              : `${consumed} runs in window`
        }
        truncated={truncated}
      />
    </div>
  );
}
