import { Progress } from "@/shared/ui/progress";
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

function barColorClass(percentage: number): string {
  if (percentage > 80) return "[&>div]:bg-destructive";
  if (percentage >= 60) return "[&>div]:bg-amber-500";
  return "[&>div]:bg-emerald-500";
}

/**
 * Runs consumed inside a budget's window, computed from kind:44200 agent
 * turn metrics. When the metric fetch hits its cap the count is a floor,
 * so the honest display is ">N in window" instead of a wrong percentage.
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

  if (truncated) {
    return (
      <div className="mt-1.5 space-y-0.5">
        <p className="text-2xs font-medium text-amber-600 dark:text-amber-400">
          {`>${METRIC_FETCH_LIMIT} turns in window — count is a floor`}
        </p>
        <p className="text-2xs text-muted-foreground">
          {RESET_HINT[budget.window]}
        </p>
      </div>
    );
  }

  const hasCeiling = typeof limit === "number";
  const percentage = hasCeiling && limit > 0 ? (consumed / limit) * 100 : null;

  return (
    <div className="mt-1.5 space-y-1">
      <Progress
        aria-label={label}
        className={percentage !== null ? barColorClass(percentage) : undefined}
        value={percentage === null ? null : Math.min(100, percentage)}
      />
      <p className="text-2xs text-muted-foreground">
        {hasCeiling
          ? `${consumed} / ${limit} runs used · ${RESET_HINT[budget.window]}`
          : `${consumed} runs in window · no runs ceiling · ${RESET_HINT[budget.window]}`}
      </p>
    </div>
  );
}
