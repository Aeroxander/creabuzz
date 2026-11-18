/**
 * Performance-package vesting validation.
 *
 * MetaDAO's shape (plan §5 B5): tranches unlock at price multiples of the
 * raise price, a cliff before anything moves, ascending multiples, percentages
 * reconciling to 100. The record carries the config; the enforcer is deferred
 * (plan §7.4). These rules prevent a republish from silently changing the
 * package an investor saw at bid time.
 */

import type { VestingConfig } from "../models";

export interface VestingIssue {
  field: "vesting";
  severity: "error" | "warning";
  message: string;
}

/** The default ladder MetaDAO ships: cliff, then 2x/4x/8x/16x/32x. */
export const DEFAULT_PERFORMANCE_TRANCHES = [
  { multiple: 2, percent: 20 },
  { multiple: 4, percent: 20 },
  { multiple: 8, percent: 20 },
  { multiple: 16, percent: 20 },
  { multiple: 32, percent: 20 },
];

export function validateVesting(
  vesting: VestingConfig | null | undefined,
): VestingIssue[] {
  const issues: VestingIssue[] = [];
  if (!vesting) return issues;
  if (vesting.cliffBlocks < 0) {
    issues.push({
      field: "vesting",
      severity: "error",
      message: "The wait before the first unlock cannot be negative.",
    });
  }
  const total = vesting.tranches.reduce((acc, t) => acc + t.percent, 0);
  if (total !== 100) {
    issues.push({
      field: "vesting",
      severity: "error",
      message: `The parts must add up to 100% (they add up to ${total}%).`,
    });
  }
  for (let i = 1; i < vesting.tranches.length; i++) {
    if (vesting.tranches[i].multiple <= vesting.tranches[i - 1].multiple) {
      issues.push({
        field: "vesting",
        severity: "error",
        message: "Each price multiple must be higher than the one before.",
      });
      break;
    }
  }
  const first = vesting.tranches[0].multiple;
  if (first <= 1) {
    issues.push({
      field: "vesting",
      severity: "warning",
      message:
        "A part at 1x would unlock at the raise price. Price-based unlocks should start above it.",
    });
  }
  if (vesting.twapWindow !== null && vesting.twapWindow <= 0) {
    issues.push({
      field: "vesting",
      severity: "warning",
      message: "The price-averaging window must be more than 0 blocks.",
    });
  }
  return issues;
}
