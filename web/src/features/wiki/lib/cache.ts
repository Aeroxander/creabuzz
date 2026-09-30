/**
 * Optional local cache.
 *
 * The wiki mirrors pages into an OPFS-backed SQLite database so it opens
 * instantly and works offline. That database needs OPFS, which some browsers
 * and some deployments (missing cross-origin-isolation headers behind a proxy
 * or CDN) do not provide. The relay is the source of truth, so the cache is an
 * optimisation: a missing or broken cache must not fail a read, and must never
 * turn a publish the relay accepted into a reported failure.
 *
 * Alias-free so `cache.test.mjs` can drive it under `node --test`.
 */

/** The slice of the SQLite handle this module needs. */
export interface CacheHandle {
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Run `read` against the cache when one can be opened, otherwise return
 * `fallback`. Never throws: opening, reading and writing all degrade.
 */
export async function withCache<T>(
  open: () => Promise<CacheHandle | null>,
  run: (db: CacheHandle) => Promise<T>,
  fallback: T,
): Promise<T> {
  let db: CacheHandle | null = null;
  try {
    db = await open();
  } catch {
    return fallback;
  }
  if (!db) return fallback;
  try {
    return await run(db);
  } catch {
    return fallback;
  }
}
