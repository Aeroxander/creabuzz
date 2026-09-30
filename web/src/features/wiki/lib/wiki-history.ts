/**
 * Per-page version history and restore.
 *
 * A wiki page's history is its chain of `kind:44001` snapshots under one `d`
 * slug. This module turns those events (already held by the cache / page index
 * — no fetching here) into a revision list, and builds the RESTORE payload
 * that puts an old version's content back on the page.
 *
 * Restoring NEVER rewrites history. A revision is an immutable, signed event;
 * the honest way to "go back" is to publish the old content as a NEW revision
 * (a new timestamp under the same `d` slug, authored by the current user). The
 * prior revisions stay on the relay exactly as they were, so the history keeps
 * growing and the restore itself is just another entry in it.
 *
 * Alias-free on purpose: `wiki-history.test.mjs` drives it under `node --test`.
 */

/** The team page kind (human wiki) — the only kind with per-page history. */
export const KIND_WIKI_PAGE = 44001;

/** The subset of a Nostr event this module needs. */
export interface HistoryEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** One entry in a page's revision list. */
export interface Revision {
  /** Event id of this snapshot. */
  id: string;
  authorPubkey: string;
  createdAt: number;
  /** First line(s) of the content, for the list. */
  excerpt: string;
  /** Full content — what a restore republishes. */
  content: string;
  /** Team scope tag (`team:<id>`) this revision carried, or null. */
  scope: string | null;
}

function tagValue(event: HistoryEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0) {
      return tag[1];
    }
  }
  return null;
}

/** A correction-suggestion proposal is a record about a page, not a revision. */
function isSuggestion(event: HistoryEvent): boolean {
  return event.tags.some(
    (tag) =>
      tag[0] === "t" &&
      typeof tag[1] === "string" &&
      tag[1].startsWith("correction-for:"),
  );
}

/** The `t: team:<id>` scope a revision carried, or null. */
function scopeOf(event: HistoryEvent): string | null {
  for (const tag of event.tags) {
    if (tag[0] !== "t") continue;
    const value = typeof tag[1] === "string" ? tag[1] : "";
    if (value.startsWith("team:") && value.length > 5) return value.slice(5);
  }
  return null;
}

/** A one-line preview of content: collapsed whitespace, bounded, ellipsised. */
export function excerpt(content: string, max = 120): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * Build a page's revision list from its `kind:44001` events, newest first.
 * Only events under this page's `d` slug count; correction suggestions are
 * excluded. Ties break to the lexicographically greater event id so the list is
 * deterministic regardless of relay ordering.
 */
export function buildHistory(
  events: readonly HistoryEvent[],
  slug: string,
): Revision[] {
  const revisions: Revision[] = [];
  for (const event of events) {
    if (event.kind !== KIND_WIKI_PAGE) continue;
    if (isSuggestion(event)) continue;
    if (tagValue(event, "d") !== slug) continue;
    const content = typeof event.content === "string" ? event.content : "";
    revisions.push({
      id: event.id,
      authorPubkey: event.pubkey,
      createdAt: event.created_at,
      excerpt: excerpt(content),
      content,
      scope: scopeOf(event),
    });
  }
  return revisions.sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  );
}

/** The event template a caller signs and publishes to restore a revision. */
export interface RestorePayload {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

/**
 * Build the RESTORE payload for `revision`.
 *
 * This publishes the revision's content as a NEW snapshot — `created_at` is the
 * supplied `now` (never the original revision's timestamp) under the same `d`
 * slug, so history grows instead of being rewritten. The signer is the current
 * user (signing sets the author); the revision's team-scope tag is carried over
 * so a restore does not silently widen or narrow who may edit the page next.
 */
export function restorePayload(
  revision: Revision,
  opts: { now: number; slug: string },
): RestorePayload {
  const tags: string[][] = [["d", opts.slug]];
  if (revision.scope) tags.push(["t", `team:${revision.scope}`]);
  return {
    kind: KIND_WIKI_PAGE,
    tags,
    content: revision.content,
    // A brand-new timestamp: restoring is a fresh publication, not an edit of
    // the historical event. This is the line a "rewrite history" mutation would
    // change, and `wiki-history.test.mjs` fails if it does.
    created_at: opts.now,
  };
}
