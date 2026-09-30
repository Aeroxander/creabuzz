import type { AgentStopRecord } from "./agentStop.ts";

function dTagOf(tags: string[][]): string | null {
  const d = tags.find((t) => t[0] === "d");
  return d && typeof d[1] === "string" ? d[1] : null;
}

export type StopEvent = {
  id: string;
  tags: string[][];
  created_at: number;
  content: string;
};

export type StopQuery = (filter: {
  kinds: number[];
  authors: string[];
  limit: number;
  until?: number;
}) => Promise<StopEvent[]>;

/**
 * Read EVERY live record the caller authored for `kind`, paging to
 * exhaustion. The relay keeps one live revision per replaceable record
 * (superseded revisions are soft-deleted), so paging until a short or empty
 * page sees the complete set — the old fixed 200-record window silently
 * missed older seats and grants in large orgs while the stop still reported
 * success.
 *
 * `maxPages` is a safety valve: hitting it THROWS instead of returning a
 * partial set, so the stop report says what it could not verify and the
 * whole stop can be re-run — never a false "stopped".
 */
export async function fetchOwnRecords(
  query: StopQuery,
  author: string,
  kind: number,
  dTag?: string,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<AgentStopRecord[]> {
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 100;
  const seen = new Map<string, AgentStopRecord>();
  let until: number | undefined;
  let exhausted = false;
  for (let page = 0; page < maxPages; page += 1) {
    const events = await query({
      kinds: [kind],
      authors: [author],
      limit: pageSize,
      ...(until === undefined ? {} : { until }),
    });
    let fresh = 0;
    for (const event of events) {
      if (seen.has(event.id)) continue;
      const d = dTagOf(event.tags);
      if (d === null) continue;
      seen.set(event.id, {
        d,
        createdAt: event.created_at,
        content: event.content,
      });
      fresh += 1;
    }
    if (events.length < pageSize) {
      exhausted = true;
      break;
    }
    const oldest = events.reduce(
      (min, e) => Math.min(min, e.created_at),
      Number.POSITIVE_INFINITY,
    );
    // A full page of duplicates cannot advance the cursor: stop rather than
    // spin (the safety valve below would otherwise be the only exit).
    if (fresh === 0) {
      exhausted = true;
      break;
    }
    until = oldest;
  }
  if (!exhausted) {
    throw new Error(
      "Could not read every record — run the stop again to verify the rest.",
    );
  }
  return [...seen.values()].filter((r) => dTag === undefined || r.d === dTag);
}
