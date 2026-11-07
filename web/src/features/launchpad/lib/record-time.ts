/**
 * The `created_at` for a record that replaces another with the same address.
 *
 * Replaceable events resolve by time, and a tie by event id, so a save in the
 * same second as the previous one can silently lose. Staying one second past
 * the record being replaced makes the later save always win.
 *
 * Alias-free on purpose: `record-time.test.mjs` drives it under `node --test`.
 */
export function supersedingTime(
  nowSeconds: number,
  previousCreatedAt: number | null | undefined,
): number {
  return Math.max(nowSeconds, (previousCreatedAt ?? 0) + 1);
}
