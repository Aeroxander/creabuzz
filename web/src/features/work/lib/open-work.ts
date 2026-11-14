/**
 * The open work on the Work page: each listed project's standing request for help, with its size, filtered by size.
 *
 * Pure and alias-free: `open-work.test.mjs` drives it under `node --test`.
 */

import type { HelpSize } from "../../launchpad/lib/weekly-update.ts";

/** The size chips: every size, or one. */
export type SizeFilter = "all" | HelpSize;

export const SIZE_FILTERS: readonly { id: SizeFilter; label: string }[] = [
  { id: "all", label: "Any size" },
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

/** The requests of one size (or all of them), in the order given. */
export function bySize<T extends { ask: { size: HelpSize } }>(
  requests: readonly T[],
  filter: SizeFilter,
): T[] {
  return filter === "all"
    ? [...requests]
    : requests.filter((request) => request.ask.size === filter);
}

/** "3 open requests", "1 open request", "No open requests". */
export function openCountLine(count: number): string {
  if (count === 0) return "No open requests";
  return count === 1 ? "1 open request" : `${count} open requests`;
}
