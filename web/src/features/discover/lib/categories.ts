/**
 * Category browsing for Discover: the distinct `t` tags carried by launch
 * records, and the bounded, paginated query that browses one of them.
 *
 * The directory used to pull every row in one query; a category browse is a
 * paged `#t` query instead — explicit kinds and a page size on every request
 * (the p-gate rejects wildcard filters anyway), and an `until` cursor so
 * "load more" walks back in time rather than pulling the world.
 *
 * The shared `t` tag every record carries (`"dao-launchpad"`) is a routing
 * marker, not a topic, so it is not offered as a category.
 *
 * Pure and alias-free: `categories.test.mjs` drives it under `node --test`.
 */

import { KIND_LAUNCH_RECORD } from "../../../shared/constants/kinds.ts";

/** The tag shared by every launch record — a routing marker, not a topic. */
export const LAUNCH_ROUTING_TAG = "dao-launchpad";

/** One page of category results. */
export const CATEGORY_PAGE_SIZE = 24;

/** The structural slice of an event category browsing needs. */
export interface TaggedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
}

/** Distinct topic tags on launch records, sorted for a stable picker. */
export function collectCategories(events: readonly TaggedEvent[]): string[] {
  const found = new Set<string>();
  for (const event of events) {
    if (event.kind !== KIND_LAUNCH_RECORD) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "t" || typeof tag[1] !== "string") continue;
      const topic = tag[1].trim().toLowerCase();
      if (topic === "" || topic === LAUNCH_ROUTING_TAG) continue;
      found.add(topic);
    }
  }
  return [...found].sort();
}

/**
 * The filter for one page of a category browse (or of the whole launch list
 * when `category` is null). Every request names its kinds and page size; a
 * cursor pages further back in time.
 */
export function buildCategoryQuery(input: {
  category: string | null;
  limit?: number;
  until?: number | null;
}): {
  kinds: number[];
  limit: number;
  "#t"?: string[];
  until?: number;
} {
  const query: {
    kinds: number[];
    limit: number;
    "#t"?: string[];
    until?: number;
  } = {
    kinds: [KIND_LAUNCH_RECORD],
    limit: input.limit ?? CATEGORY_PAGE_SIZE,
  };
  if (input.category) query["#t"] = [input.category];
  if (input.until != null) query.until = input.until;
  return query;
}

/**
 * The cursor for the next page: just before the oldest event seen, so the
 * next page continues without overlap. Null when the page was empty.
 */
export function nextPageCursor(events: readonly TaggedEvent[]): number | null {
  if (events.length === 0) return null;
  let oldest = events[0].created_at;
  for (const event of events) oldest = Math.min(oldest, event.created_at);
  return oldest - 1;
}
