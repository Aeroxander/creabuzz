/**
 * Community wiki pages.
 *
 * Pages are kind:44001 addressable events (d = slug, content = markdown),
 * stored on the relay and mirrored into a local op-sqlite (OPFS) cache so
 * the wiki opens instantly and works offline. Publishing writes through to
 * the relay; the cache is a cache, the relay stays the source of truth.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";

const KIND_WIKI_PAGE = 44001;

export interface WikiPage {
  slug: string;
  content: string;
  updatedAt: number;
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

// ── local cache (op-sqlite / OPFS) ──────────────────────────────────────────

interface WikiDb {
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  closeAsync(): Promise<void>;
}

let dbPromise: Promise<WikiDb> | null = null;

function openWikiDb(): Promise<WikiDb> {
  if (!dbPromise) {
    dbPromise = import("@op-engineering/op-sqlite").then(({ openAsync }) =>
      openAsync({ name: "buzz-wiki.db", location: "default" }).then((db) =>
        db
          .execute(
            "CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, content TEXT, updated_at INTEGER)",
          )
          .then(() => db as unknown as WikiDb),
      ),
    );
  }
  return dbPromise;
}

interface CachedPageRow {
  slug: string;
  content: string;
  updated_at: number;
}

async function loadCachedPages(): Promise<WikiPage[]> {
  const db = await openWikiDb();
  const result = await db.execute(
    "SELECT slug, content, updated_at FROM pages",
  );
  return (result.rows as unknown as CachedPageRow[]).map((row) => ({
    slug: row.slug,
    content: row.content,
    updatedAt: row.updated_at,
  }));
}

async function cachePage(page: WikiPage): Promise<void> {
  const db = await openWikiDb();
  if (!db) return;
  await db.execute(
    "INSERT OR REPLACE INTO pages (slug, content, updated_at) VALUES (?, ?, ?)",
    [page.slug, page.content, page.updatedAt],
  );
}

// ── relay source of truth ───────────────────────────────────────────────────

async function fetchWikiPages(): Promise<WikiPage[]> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_WIKI_PAGE],
    limit: 200,
  });
  const latestBySlug = new Map<string, NostrEvent>();
  for (const event of events) {
    const slug = getTag(event, "d") ?? event.id;
    const previous = latestBySlug.get(slug);
    if (!previous || event.created_at > previous.created_at) {
      latestBySlug.set(slug, event);
    }
  }
  return [...latestBySlug.values()].map((event) => ({
    slug: getTag(event, "d") ?? event.id,
    content: typeof event.content === "string" ? event.content : "",
    updatedAt: event.created_at,
  }));
}

// ── hooks ───────────────────────────────────────────────────────────────────

/** Wiki page list: instant from the local cache, refreshed from the relay. */
export function useWikiPages(enabled: boolean) {
  const [cached, setCached] = useState<WikiPage[]>([]);
  useEffect(() => {
    if (!enabled) return;
    void loadCachedPages().then((pages) => setCached(pages));
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
    });
  }, []);

  return { pages, isLoading: relayQuery.isLoading, savePage };
}

/** [[wikilinks]] and #tags mentioned in wiki content. */
export function extractLinks(content: string): string[] {
  const links: string[] = [];
  const wikiLink = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  while (true) {
    const match = wikiLink.exec(content);
    if (!match) break;
    links.push(match[1].trim().replace(/\s+/g, "-").toLowerCase());
  }
  const tag = /(^|\s)#([a-zA-Z0-9_-]{2,40})/g;
  while (true) {
    const tagMatch = tag.exec(content);
    if (!tagMatch) break;
    links.push(`tag:${tagMatch[2].toLowerCase()}`);
  }
  return [...new Set(links)];
}
