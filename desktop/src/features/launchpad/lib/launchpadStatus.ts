import type { Launch, LaunchStage } from "@/features/launchpad/launchpadModels";

/**
 * Effective launch stage. The record's `stage` is a display hint; graduation
 * and failure receipts override it because the chain determines the truth.
 * Pure and side-effect free.
 */
export function effectiveLaunchStage(launch: Launch): LaunchStage {
  const tables = new Set(launch.receipts.map((r) => r.table));
  if (tables.has("summon") || tables.has("graduate")) return "graduated";
  if (tables.has("refund-open") || tables.has("failed")) return "failed";
  return launch.record.stage;
}

export const STAGE_LABELS: Record<LaunchStage, string> = {
  draft: "Draft",
  review: "In review",
  live: "Live",
  funding: "Funding",
  graduated: "Graduated",
  failed: "Failed",
};

export function totalBidBudget(launch: Launch): bigint {
  let total = 0n;
  for (const bid of launch.bids) {
    if (!bid.budget) continue;
    try {
      total += BigInt(bid.budget);
    } catch {
      // Non-numeric budgets are display-only mirrors; skip them.
    }
  }
  return total;
}
