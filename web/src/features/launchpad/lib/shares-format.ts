import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";

/** A Shares amount (18 decimals) as people read it: whole Shares once there are thousands of them, else a few decimals. */
export function formatShares(wei: bigint): string {
  return formatUnits(wei, 18, wei >= 1000n * 10n ** 18n ? 0 : 4);
}
