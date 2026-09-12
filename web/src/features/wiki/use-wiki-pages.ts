/**
 * Community wiki pages.
 *
 * Pages are kind:44001 addressable events (d = slug, content = markdown),
 * stored on the relay and mirrored into a local op-sqlite (OPFS) cache so
 * the wiki opens instantly and works offline. Publishing writes through to
 * the relay; the cache is a cache, the relay stays the source of truth.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizeSlug } from "./lib/slug";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser, userPubkey } from "@/shared/lib/identity";

import { withCache } from "./lib/cache";
import {
  buildPages,
  KIND_DELETE,
  KIND_WIKI_PAGE,
  pageCoordinate,
} from "./lib/page-index";

export interface WikiPage {
  slug: string;
  content: string;
  updatedAt: number;
  /** Author of the winning snapshot; the delete tombstone must match it. */
  authorPubkey?: string;
  /** True for a page that only exists in this editor and is not published yet. */
  draft?: boolean;
}

// ── local cache (op-sqlite / OPFS) ──────────────────────────────────────────

interface WikiDb {
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  closeAsync(): Promise<void>;
}

let dbPromise: Promise<WikiDb | null> | null = null;

/**
 * Open the local cache, or resolve `null` when the browser cannot provide one.
 *
 * The cache needs OPFS, which some browsers and some deployments (missing
 * cross-origin-isolation headers behind a proxy or CDN) do not provide. The
 * cache is an optimisation — the relay is the source of truth — so a missing
 * cache must never fail a read, and above all must never turn a publish that
 * the relay accepted into a reported save failure.
 */
function openWikiDb(): Promise<WikiDb | null> {
  if (!dbPromise) {
    dbPromise = import("@op-engineering/op-sqlite")
      .then(({ openAsync }) =>
        openAsync({ name: "buzz-wiki.db", location: "default" }).then((db) =>
          db
            .execute(
              "CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, content TEXT, updated_at INTEGER)",
            )
            .then(() => db as unknown as WikiDb),
        ),
      )
      .catch((error: unknown) => {
        console.warn(
          "[wiki] local cache unavailable; using the relay only",
          error,
        );
        return null;
      });
  }
  return dbPromise;
}

interface CachedPageRow {
  slug: string;
  content: string;
  updated_at: number;
}

async function loadCachedPages(): Promise<WikiPage[]> {
  return withCache(
    openWikiDb,
    async (db) => {
      const result = await db.execute(
        "SELECT slug, content, updated_at FROM pages",
      );
      return (result.rows as unknown as CachedPageRow[]).map((row) => ({
        slug: row.slug,
        content: row.content,
        updatedAt: row.updated_at,
      }));
    },
    [],
  );
}

async function cachePage(page: WikiPage): Promise<void> {
  await withCache(
    openWikiDb,
    async (db) => {
      await db.execute(
        "INSERT OR REPLACE INTO pages (slug, content, updated_at) VALUES (?, ?, ?)",
        [page.slug, page.content, page.updatedAt],
      );
    },
    undefined,
  );
}

async function dropCachedPage(slug: string): Promise<void> {
  await withCache(
    openWikiDb,
    async (db) => {
      await db.execute("DELETE FROM pages WHERE slug = ?", [slug]);
    },
    undefined,
  );
}

// ── relay source of truth ───────────────────────────────────────────────────

export async function fetchWikiPages(): Promise<WikiPage[]> {
  // Tombstones come back in the same query so a deleted page disappears here
  // as well as on every other client.
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_WIKI_PAGE, KIND_DELETE],
    limit: 200,
  });
  return buildPages(
    events.map((event: NostrEvent) => ({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags as string[][],
      content: event.content,
    })),
  );
}

// ── hooks ───────────────────────────────────────────────────────────────────

/** Wiki page list: instant from the local cache, refreshed from the relay. */
export function useWikiPages(enabled: boolean) {
  const queryClient = useQueryClient();
  const [cached, setCached] = useState<WikiPage[]>([]);
  useEffect(() => {
    if (!enabled) return;
    void loadCachedPages()
      .then((pages) => setCached(pages))
      .catch(() => {
        // The cache is optional; `loadCachedPages` already degrades.
      });
  }, [enabled]);

  const relayQuery = useQuery({
    queryKey: ["wiki-pages"],
    queryFn: fetchWikiPages,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // Cross-tab snapshot convergence: every tab polls the relay so edits
    // auto-saved by another tab reach this one without P2P signaling.
    refetchInterval: enabled ? 5000 : false,
  });

  useEffect(() => {
    if (!enabled) return;
    const pages = relayQuery.data;
    if (pages) void Promise.all(pages.map(cachePage)).catch(() => {});
  }, [enabled, relayQuery.data]);

  const pages = useMemo(() => {
    const bySlug = new Map<string, WikiPage>();
    for (const page of cached) bySlug.set(page.slug, page);
    for (const page of relayQuery.data ?? []) bySlug.set(page.slug, page);
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }, [cached, relayQuery.data]);

  /** Fresh page set straight from the relay, bypassing the query cache. */
  const readFreshPages = useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: ["wiki-pages"],
        queryFn: fetchWikiPages,
        staleTime: 0,
      }),
    [queryClient],
  );

  const savePage = useCallback(async (slug: string, content: string) => {
    const signed = await signAsUser({
      kind: KIND_WIKI_PAGE,
      tags: [["d", slug]],
      content,
    });
    const result = await publishEvent(relayWsUrl(), signed, {
      signAuth: signAsUser,
    });
    if (!result.accepted) {
      throw new Error(result.message ?? "relay rejected the wiki page");
    }
    await cachePage({
      slug,
      content,
      updatedAt: Math.floor(Date.now() / 1000),
      authorPubkey: signed.pubkey,
    });
  }, []);

  /**
   * Delete a page with a NIP-09 tombstone naming its addressable coordinate.
   *
   * The relay keeps the tombstone rather than the page, so every client hides
   * the page without needing addressable-event delete semantics. Only the
   * author's tombstone counts (`lib/page-index.ts`).
   */
  const deletePage = useCallback(async (page: WikiPage) => {
    const author = page.authorPubkey ?? userPubkey();
    const signed = await signAsUser({
      kind: KIND_DELETE,
      tags: [["a", pageCoordinate(author, page.slug)]],
      content: "",
    });
    const result = await publishEvent(relayWsUrl(), signed, {
      signAuth: signAsUser,
    });
    if (!result.accepted) {
      throw new Error(result.message ?? "relay rejected the delete");
    }
    await dropCachedPage(page.slug);
  }, []);

  /** Rename by republishing under the new slug, then tombstoning the old one. */
  const renamePage = useCallback(
    async (page: WikiPage, nextSlug: string) => {
      await savePage(nextSlug, page.content);
      await deletePage({ ...page, slug: page.slug });
    },
    [deletePage, savePage],
  );

  return {
    pages,
    isLoading: relayQuery.isLoading,
    savePage,
    deletePage,
    renamePage,
    readFreshPages,
    /** Why the relay page list is missing or stale, when it is. */
    loadError: relayQuery.error,
    refetchPages: relayQuery.refetch,
  };
}

/**
 * `[[wikilinks]]` and `#tags` mentioned in wiki content.
 *
 * A wikilink is a page name written by hand, so it has to be normalised exactly
 * the way the page dialog normalises a slug: `[[Release Notes!]]` used to become
 * `release-notes!` here while the page's slug was `release-notes`, so the link
 * never resolved and the backlinks panel would have missed it too.
 */
export function extractLinks(content: string): string[] {
  const links: string[] = [];
  const wikiLink = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  while (true) {
    const match = wikiLink.exec(content);
    if (!match) break;
    const slug = normalizeSlug(match[1]);
    if (slug.length > 0) links.push(slug);
  }
  const tag = /(^|\s)#([a-zA-Z0-9_-]{2,40})/g;
  while (true) {
    const tagMatch = tag.exec(content);
    if (!tagMatch) break;
    links.push(`tag:${tagMatch[2].toLowerCase()}`);
  }
  return [...new Set(links)];
}
