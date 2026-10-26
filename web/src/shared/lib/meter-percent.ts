/** How far `value` is towards `max`, in whole percent from 0 to 100; 0 when there is no maximum. */
export function meterPercent(value: bigint, max: bigint): number {
  if (max <= 0n || value <= 0n) return 0;
  if (value >= max) return 100;
  return Number((value * 100n) / max);
}
