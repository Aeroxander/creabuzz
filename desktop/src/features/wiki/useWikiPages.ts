/**
 * Community wiki pages — the read path.
 *
 * One bounded, kinds-explicit relay query fetches both wiki kinds plus
 * tombstones (kind:5) so deleted human pages disappear here as well:
 *
 * - kind:44001 human wiki pages (`d` = slug),
 * - kind:44002 agent wiki standups (`d` = `<space>/<slug>`, read-side LWW).
 *
 * Both kinds are community-level/global-only — the filter deliberately carries
 * no `h` tag (docs/agent-wiki.md). The desktop surface is read-only for now:
 * the live-collab editing surface (Yjs/Trystero) stays web-only.
 */
import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_AGENT_WIKI_PAGE,
  KIND_DELETION,
  KIND_WIKI_PAGE,
} from "@/shared/constants/kinds";

import {
  buildTombstonedWikiPages,
  buildWikiPages,
  humanPageCoordinate,
  type TombstonedWikiPage,
  type WikiPage,
} from "./lib/pageIndex";
import { buildDeleteMarkerPayload, buildPageSavePayload } from "./lib/pageEdit";
import { signRelayEvent } from "@/shared/api/tauri";

export const wikiQueryKey = ["wiki", "pages"] as const;

/** Bounded read: the wiki fetch never pulls more than this many events. */
export const WIKI_FETCH_LIMIT = 200;

const WIKI_STALE_TIME_MS = 30_000;
const WIKI_GC_TIME_MS = 5 * 60_000;

/** Fetch both wiki kinds + tombstones and fold them into the current pages. */
export async function fetchWikiPages(): Promise<WikiPage[]> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_WIKI_PAGE, KIND_DELETION, KIND_AGENT_WIKI_PAGE],
    limit: WIKI_FETCH_LIMIT,
  });
  return buildWikiPages(events);
}

/**
 * Pages hidden by a restorable tombstone — the "Recently deleted" list. The
 * relay's `include_deleted: true` filter extension returns tombstoned pages.
 *
 * TODO(relay seam): built against the `include_deleted` contract; once the
 * relay side lands, drop this note. A relay that does not know the extension
 * answers with live pages only and the list comes back empty (harmless).
 */
export async function fetchTombstonedPages(): Promise<TombstonedWikiPage[]> {
  const filter = {
    kinds: [KIND_WIKI_PAGE, KIND_DELETION],
    limit: WIKI_FETCH_LIMIT,
    include_deleted: true,
  } as Parameters<typeof relayClient.fetchEvents>[0] & {
    include_deleted?: boolean;
  };
  const events = await relayClient.fetchEvents(filter);
  return buildTombstonedWikiPages(events);
}

export const tombstonesQueryKey = ["wiki", "tombstones"] as const;

/** Recently-deleted pages, bounded, with retry state. */
export function useTombstonedPages(enabled = true) {
  return useQuery({
    queryKey: tombstonesQueryKey,
    queryFn: fetchTombstonedPages,
    staleTime: 15_000,
    gcTime: WIKI_GC_TIME_MS,
    enabled,
  });
}

/**
 * Restore a tombstoned page: republish its content as a NEW revision (the
 * relay's restore path is an authorized editor's accepted revision), scope
 * carried over so a restore never re-scopes the page.
 */
export async function restoreTombstonedPage(
  entry: TombstonedWikiPage,
): Promise<void> {
  const payload = buildPageSavePayload({
    slug: entry.slug,
    content: entry.content,
    now: Math.floor(Date.now() / 1000),
    scope: entry.scope,
  });
  const event = await signRelayEvent({
    kind: payload.kind,
    content: payload.content,
    tags: payload.tags,
    createdAt: payload.created_at,
  });
  await relayClient.publishEvent(
    event,
    "Timed out while restoring the page.",
    "Failed to restore the page.",
  );
}

/**
 * Delete (or purge) a page with a delete marker naming its coordinate. The
 * purge tag is admin-only (refused by the builder otherwise).
 */
export async function deleteWikiPage(input: {
  slug: string;
  authorPubkey: string;
  purge: boolean;
  viewerIsAdmin: boolean;
}): Promise<void> {
  const payload = buildDeleteMarkerPayload({
    coordinate: humanPageCoordinate(input.authorPubkey, input.slug),
    purge: input.purge,
    viewerIsAdmin: input.viewerIsAdmin,
    now: Math.floor(Date.now() / 1000),
  });
  const event = await signRelayEvent({
    kind: payload.kind,
    content: payload.content,
    tags: payload.tags,
    createdAt: payload.created_at,
  });
  await relayClient.publishEvent(
    event,
    "Timed out while deleting the page.",
    "Failed to delete the page.",
  );
}

/**
 * Seat holders of a team node id from the org chart (kind:37010), or null
 * when the scope cannot be resolved — the gate keeps ordinary members
 * read-only in that case (the relay would reject their edit).
 */
export async function fetchTeamSeats(): Promise<
  (teamId: string) => string[] | null
> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_ORG_NODE],
    limit: 200,
  });
  const seats = new Map<string, Set<string>>();
  for (const event of events) {
    const id = event.tags.find((t) => t[0] === "d")?.[1];
    if (!id) continue;
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(event.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed node content: an unresolvable scope.
    }
    if (body.kind !== "team") continue;
    const holders = [
      ...(Array.isArray(body.holders) ? body.holders : []),
      ...(Array.isArray(body.agentSeats) ? body.agentSeats : []),
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    const set = seats.get(id) ?? new Set<string>();
    for (const holder of holders) set.add(holder.toLowerCase());
    seats.set(id, set);
  }
  return (teamId) => {
    const set = seats.get(teamId);
    return set ? [...set] : null;
  };
}

export function useTeamSeats(enabled = true) {
  return useQuery({
    queryKey: ["wiki", "team-seats"],
    queryFn: fetchTeamSeats,
    staleTime: 60_000,
    enabled,
  });
}

/** NIP-ORG org-node kind, for resolving a page's team scope to its seats. */
export const KIND_ORG_NODE = 37010;

/** All wiki page heads (human + agent), read-only. */
export function useWikiPages(enabled = true) {
  return useQuery({
    queryKey: wikiQueryKey,
    queryFn: fetchWikiPages,
    staleTime: WIKI_STALE_TIME_MS,
    gcTime: WIKI_GC_TIME_MS,
    enabled,
  });
}
