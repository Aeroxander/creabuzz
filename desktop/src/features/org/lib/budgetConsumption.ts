// Budget consumption windowing for NIP-ORG kind:37012 budgets, computed
// from kind:44200 agent turn metric events (NIP-AM). One metric event is one
// completed agent turn, so "runs used in the window" = events whose
// created_at falls inside the budget window.
//
// The window boundaries mirror NIP-ORG §37012's epoch mapping (the same
// division the onchain allowance contract uses): day = unix/86400,
// week = unix/604800, month = unix/2592000, epoch = governance-defined (not
// time-derived), so a client computes the same window the contract checks.

import type { BudgetWindow } from "../orgModels";

export const METRIC_KIND = 44200;

/** Fetch cap for metric events; hitting it means the window is truncated. */
export const METRIC_FETCH_LIMIT = 500;

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;
const MONTH_SECONDS = 2_592_000; // 30 days, per NIP-ORG's epoch mapping

/**
 * Inclusive lower bound (unix seconds) of the budget window that contains
 * `nowSeconds`. `epoch` windows have no time-derived boundary — returns
 * null, meaning "all-time".
 */
export function budgetWindowStart(
  window: BudgetWindow,
  nowSeconds: number,
): number | null {
  switch (window) {
    case "day":
      return Math.floor(nowSeconds / DAY_SECONDS) * DAY_SECONDS;
    case "week":
      return Math.floor(nowSeconds / WEEK_SECONDS) * WEEK_SECONDS;
    case "month":
      return Math.floor(nowSeconds / MONTH_SECONDS) * MONTH_SECONDS;
    case "epoch":
      return null;
  }
}

export type MetricEventLike = {
  created_at: number;
};

export type ConsumptionSummary = {
  /** Metric events counted inside the window (capped at the fetch limit). */
  consumed: number;
  /** The budget's runs ceiling, when it declares one. */
  limit?: number;
  /** True when the fetch hit METRIC_FETCH_LIMIT — the count is a floor. */
  truncated: boolean;
  /** Inclusive window start (unix seconds), or null for epoch windows. */
  windowStart: number | null;
};

/**
 * Count metric events inside the budget's window. Malformed rows (missing or
 * non-numeric created_at) are ignored, so a bad event never inflates or
 * crashes consumption. `hitFetchLimit` must be set by the caller when the
 * relay returned exactly METRIC_FETCH_LIMIT events.
 */
export function summarizeConsumption(
  events: MetricEventLike[],
  options: {
    window: BudgetWindow;
    runsLimit?: number;
    nowSeconds: number;
    hitFetchLimit?: boolean;
  },
): ConsumptionSummary {
  const windowStart = budgetWindowStart(options.window, options.nowSeconds);
  let consumed = 0;
  for (const event of events) {
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.created_at !== "number" ||
      !Number.isFinite(event.created_at)
    ) {
      continue;
    }
    if (windowStart === null || event.created_at >= windowStart) {
      consumed += 1;
    }
  }
  const limit =
    typeof options.runsLimit === "number" && Number.isFinite(options.runsLimit)
      ? options.runsLimit
      : undefined;
  return {
    consumed,
    limit,
    truncated: options.hitFetchLimit === true,
    windowStart,
  };
}

/** 0–100 consumption percentage; null when there is no ceiling to compare. */
export function consumptionPercentage(
  summary: ConsumptionSummary,
): number | null {
  if (!summary.limit || summary.limit <= 0) return null;
  return (summary.consumed / summary.limit) * 100;
}
