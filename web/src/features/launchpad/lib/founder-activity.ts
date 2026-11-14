/**
 * What is new on a founder's launches since they last looked: supporters who
 * arrived. The supporter count is read from other people's lists, so "new" is
 * the difference from the count the founder last saw, not a timestamp (a list's
 * time moves whenever its owner changes anything in it).
 *
 * Alias-free on purpose: `founder-activity.test.mjs` drives it under `node --test`.
 */

/** The supporter count last seen, per launch coordinate. */
export type SeenCounts = Record<string, number>;

export function parseSeenCounts(raw: string | null): SeenCounts {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const out: SeenCounts = {};
    for (const [coord, count] of Object.entries(value)) {
      if (
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
      ) {
        out[coord] = count;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface ActivityRow {
  coord: string;
  id: string;
  author: string;
  name: string;
  /** Supporters who arrived since the founder last looked. */
  fresh: number;
  total: number;
}

/** Launches with new supporters, most new first. Launches with none are left out. */
export function activityRows(
  mine: ReadonlyArray<{
    coord: string;
    id: string;
    author: string;
    name: string;
  }>,
  counts: ReadonlyMap<string, number>,
  seen: SeenCounts,
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const launch of mine) {
    const total = counts.get(launch.coord) ?? 0;
    const fresh = Math.max(0, total - (seen[launch.coord] ?? 0));
    if (fresh > 0) rows.push({ ...launch, fresh, total });
  }
  return rows.sort((a, b) => b.fresh - a.fresh || a.name.localeCompare(b.name));
}
