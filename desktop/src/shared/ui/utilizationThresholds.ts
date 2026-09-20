/**
 * Pure threshold math for budget utilization (docs/paperclip-ux-reference.md
 * 2.5 + P0 item 3). No React, no DOM: `UtilizationBar.tsx` consumes this, and
 * the 70/90 contract is unit-tested (`utilizationBar.test.mjs`) without
 * mounting components. Every consumer shares one threshold vocabulary:
 * <70% green (ok), 70-90% amber (waiting), >90% red (blocking).
 */

/** Utilization at or above this percentage reads as "waiting" (amber). */
export const UTILIZATION_AMBER_THRESHOLD = 70;

/** Utilization strictly above this percentage reads as "blocking" (red). */
export const UTILIZATION_RED_THRESHOLD = 90;

export type UtilizationTone = "ok" | "waiting" | "blocking";

/**
 * Map a utilization percentage (0-100) to the semantic status tone. A null,
 * undefined, or non-finite percentage (no ceiling, or a count that cannot be
 * compared) is never treated as a level: it renders as "ok"/neutral rather
 * than inventing a severity.
 */
export function utilizationTone(
  percentage: number | null | undefined,
): UtilizationTone {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return "ok";
  }
  if (percentage > UTILIZATION_RED_THRESHOLD) return "blocking";
  if (percentage >= UTILIZATION_AMBER_THRESHOLD) return "waiting";
  return "ok";
}

/** Tailwind fill class per tone — status tokens only, never raw hues. */
export const UTILIZATION_TONE_BAR_CLASS: Record<UtilizationTone, string> = {
  ok: "bg-status-ok",
  waiting: "bg-status-waiting",
  blocking: "bg-status-blocking",
};

/**
 * Consumption percentage (0-100+) against a ceiling. Returns null when there
 * is no usable ceiling (missing, non-numeric, zero, negative) or the count is
 * not a usable number — the caller must then show an advisory readout, never
 * a fabricated percentage.
 */
export function utilizationPercentage(
  consumed: number,
  limit?: number | null,
): number | null {
  if (
    typeof consumed !== "number" ||
    !Number.isFinite(consumed) ||
    consumed < 0
  ) {
    return null;
  }
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return (consumed / limit) * 100;
}

export type UtilizationInput = {
  /** Percentage against the ceiling, or null when there is none. */
  percentage: number | null;
  /** True when the count hit a fetch cap: it is a floor, not a level. */
  truncated: boolean;
  /** Caller-flagged anomaly (e.g. consumed > 0 against a zero ceiling). */
  flagged?: boolean;
};

export type UtilizationSummary = {
  /** Index of the highest non-truncated percentage, or null when none. */
  worstIndex: number | null;
  /** Entries needing attention: >=70%, truncated floors, or flagged. */
  attentionCount: number;
};

/**
 * Aggregate per-budget utilization for a metric row. Truncated counts never
 * compete for "worst" (their percentage is unknowable) but they always count
 * toward attention — an unverifiable floor is exactly what an operator needs
 * to look at.
 */
export function summarizeUtilizations(
  inputs: UtilizationInput[],
): UtilizationSummary {
  let worstIndex: number | null = null;
  let worst = Number.NEGATIVE_INFINITY;
  let attentionCount = 0;
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    if (!input) continue;
    if (input.truncated || input.flagged) attentionCount += 1;
    if (
      !input.truncated &&
      input.percentage !== null &&
      typeof input.percentage === "number" &&
      Number.isFinite(input.percentage)
    ) {
      if (input.percentage >= UTILIZATION_AMBER_THRESHOLD) attentionCount += 1;
      if (input.percentage > worst) {
        worst = input.percentage;
        worstIndex = i;
      }
    }
  }
  return { worstIndex, attentionCount };
}
