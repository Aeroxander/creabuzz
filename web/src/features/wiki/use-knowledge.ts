/**
 * Knowledge data + actions for the unified wiki surface.
 *
 * One bounded relay read carries every wiki record the Knowledge area needs:
 * team pages (`kind:44001`), agent pages (`kind:44002`), and tombstones
 * (`kind:5`) so a deleted team page disappears. Correction suggestions ride
 * `kind:44001` under a `correction-for:<slug>` `t` tag (see `lib/knowledge.ts`)
 * and are folded out of the same read. Version history is the page's chain of
 * 44001 snapshots — again already in this read, so nothing extra is fetched.
 *
 * The pure classification, provenance, history and the team-scope edit gate all
 * live in `lib/` (tested under `node --test`); this file only supplies the
 * relay I/O and the React binding. The live-collab edit layer stays in
 * `wiki-sync.ts` and is deliberately untouched here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";

import {
  KIND_AGENT_WIKI_PAGE,
  KIND_WIKI_PAGE,
  type KnowledgeEvent,
  type KnowledgePage,
  type EditVerdict,
  classifyEvents,
  canEditKnowledge,
  suggestionsFor,
  appliedCorrectionsFor,
  type Suggestion,
  buildSuggestion,
  type TeamSeatResolver,
} from "./lib/knowledge";
import {
  buildHistory,
  restorePayload,
  type Revision,
} from "./lib/wiki-history";

/** Tombstone kind (NIP-09) — a deleted team page leaves one of these. */
export const KIND_DELETE = 5;
/** NIP-ORG org-node kind, for resolving a page's team scope to its seats. */
export const KIND_ORG_NODE = 37010;

/** Bounded read: the Knowledge fetch never pulls more than this many events. */
export const KNOWLEDGE_FETCH_LIMIT = 200;

function toKnowledgeEvent(event: NostrEvent): KnowledgeEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags as string[][],
    content: event.content,
  };
}

/** Fetch every wiki record + tombstone in one kinds-explicit query. */
export async function fetchKnowledgeEvents(): Promise<KnowledgeEvent[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_WIKI_PAGE, KIND_AGENT_WIKI_PAGE, KIND_DELETE],
    limit: KNOWLEDGE_FETCH_LIMIT,
  });
  return events.map(toKnowledgeEvent);
}

/**
 * Resolve a team node id to its seat holders from the org chart. Returns null
 * when the org graph cannot resolve the scope (no node, unknown team) so the
 * edit gate falls back to open editing instead of locking anyone out.
 */
function teamSeatResolver(
  orgEvents: readonly {
    kind: number;
    tags: string[][];
    content: string;
  }[],
): TeamSeatResolver {
  // Union of `holders` + `agentSeats` across every team node sharing the id.
  const seats = new Map<string, Set<string>>();
  for (const event of orgEvents) {
    if (event.kind !== KIND_ORG_NODE) continue;
    const id = event.tags.find((t) => t[0] === "d")?.[1];
    if (!id) continue;
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(event.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed node content: treated as an unresolvable scope below.
    }
    if (body.kind !== "team") continue;
    const holders = [
      ...(Array.isArray(body.holders) ? body.holders : []),
      ...(Array.isArray(body.agentSeats) ? body.agentSeats : []),
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    const set = seats.get(id) ?? new Set<string>();
    for (const h of holders) set.add(h.toLowerCase());
    seats.set(id, set);
  }
  return (teamId) => {
    const set = seats.get(teamId);
    // No team node for this id → unresolvable → caller falls back to editing.
    return set ? [...set] : null;
  };
}

export interface KnowledgeState {
  /** Team pages (human wiki), sorted by slug. */
  team: KnowledgePage[];
  /** Agent pages (read-only), sorted by slug. */
  agent: KnowledgePage[];
  isLoading: boolean;
  loadError: unknown;
  refetch: () => void;
  /** The viewer's pubkey, or null when signed out. */
  viewerPubkey: string | null;
  /** Correction suggestions filed against `slug` that are still open. */
  suggestionsFor: (slug: string) => Suggestion[];
  /** Corrections the latest agent page for `slug` has applied (for display). */
  appliedCorrectionsFor: (slug: string) => Suggestion[];
  /** Revision history for `slug`, newest first. */
  historyFor: (slug: string) => Revision[];
  /** The team-scope edit gate (see `lib/knowledge.ts`). */
  canEdit: (page: { scope: string | null }) => "edit" | "propose";
  /** Publish an old revision's content as a NEW revision. */
  restoreRevision: (slug: string, revision: Revision) => Promise<void>;
  /** File a durable correction suggestion against an agent page. */
  fileSuggestion: (slug: string, note: string) => Promise<void>;
}

export function useKnowledge(enabled = true): KnowledgeState {
  const eventsQuery = useQuery({
    queryKey: ["knowledge-pages"],
    queryFn: fetchKnowledgeEvents,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const orgQuery = useQuery({
    queryKey: ["knowledge-org"],
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_ORG_NODE],
        limit: 200,
      });
      return events.map(toKnowledgeEvent);
    },
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  const groups = useMemo(() => classifyEvents(events), [events]);
  const resolver = useMemo(
    () => teamSeatResolver(orgQuery.data ?? []),
    [orgQuery.data],
  );

  // Re-read the viewer when the query settles so a fresh sign-in is reflected.
  const [viewerPubkey, setViewerPubkey] = useState<string | null>(() =>
    existingUserPubkey(),
  );
  // `dataUpdatedAt` is a change token, not a value read in the body: it only
  // decides when to re-check who we are signing as.
  // biome-ignore lint/correctness/useExhaustiveDependencies: change token, see above
  useEffect(() => {
    setViewerPubkey(existingUserPubkey());
  }, [eventsQuery.dataUpdatedAt]);

  const historyFor = useCallback(
    (slug: string) => buildHistory(events, slug),
    [events],
  );
  const suggestions = useCallback(
    (slug: string) => suggestionsFor(events, slug),
    [events],
  );
  const appliedCorrections = useCallback(
    (slug: string) => appliedCorrectionsFor(events, slug),
    [events],
  );
  const canEdit = useCallback(
    (page: { scope: string | null }): EditVerdict =>
      canEditKnowledge(page, viewerPubkey, resolver),
    [viewerPubkey, resolver],
  );

  const restoreRevision = useCallback(
    async (slug: string, revision: Revision) => {
      const payload = restorePayload(revision, {
        now: Math.floor(Date.now() / 1000),
        slug,
      });
      const signed = await signAsUser({
        kind: payload.kind,
        tags: payload.tags,
        content: payload.content,
        created_at: payload.created_at,
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "relay rejected the restore");
      }
      await eventsQuery.refetch();
    },
    [eventsQuery],
  );

  const fileSuggestion = useCallback(
    async (slug: string, note: string) => {
      const author = existingUserPubkey();
      if (!author) throw new Error("Sign in to suggest a correction.");
      const payload = buildSuggestion({
        slug,
        note,
        authorPubkey: author,
        now: Math.floor(Date.now() / 1000),
      });
      const signed = await signAsUser({
        kind: payload.kind,
        tags: payload.tags,
        content: payload.content,
        created_at: payload.created_at,
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "relay rejected the suggestion");
      }
      await eventsQuery.refetch();
    },
    [eventsQuery],
  );

  return {
    team: groups.team,
    agent: groups.agent,
    isLoading: eventsQuery.isLoading,
    loadError: eventsQuery.error,
    refetch: () => void eventsQuery.refetch(),
    viewerPubkey,
    suggestionsFor: suggestions,
    appliedCorrectionsFor: appliedCorrections,
    historyFor,
    canEdit,
    restoreRevision,
    fileSuggestion,
  };
}
