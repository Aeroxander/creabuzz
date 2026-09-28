/**
 * Wiki page indexing: the current page set from raw relay events.
 *
 * Two kinds with two replacement contracts meet here (docs/agent-wiki.md):
 *
 * - kind:44001 (human wiki, `d` = slug) is snapshot-style: the newest event
 *   per slug wins, and a NIP-09 tombstone (kind:5, `a` = the page's
 *   coordinate) hides the page — but only when it is signed by that page's
 *   author and published at or after the page. Mirrors the web client's
 *   `web/src/features/wiki/lib/page-index.ts`.
 * - kind:44002 (agent wiki, `d` = `<space>/<slug>`) is OUTSIDE the NIP-33
 *   parameterized range, so every revision is stored and the newest event per
 *   (pubkey, kind, d) wins READ-SIDE LWW. Fold per-author heads first, then
 *   resolve the winning head per page across authors.
 *
 * Both kinds are community-level/global-only (no `h` tag). Ties on
 * `created_at` fall to the lexicographically greater event id so the page set
 * is deterministic no matter how the relay orders a batch.
 *
 * Alias-free on purpose: `pageIndex.test.mjs` drives it under `node --test`.
 */
import {
  KIND_AGENT_WIKI_PAGE,
  KIND_DELETION,
  KIND_WIKI_PAGE,
} from "@/shared/constants/kinds";

import { parseFrontMatter, type StandupFrontMatter } from "./frontMatter";
import { extractProvenance, type WikiProvenance } from "./provenance";
import { normalizeSlug, parseSpaceSlug } from "./slug";

/** The subset of a Nostr event this index needs. */
export type WikiPageEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: ReadonlyArray<readonly string[]>;
  content: string;
};

export type HumanWikiPage = {
  kind: "human";
  /** List/graph identity: the page slug. */
  key: string;
  slug: string;
  content: string;
  updatedAt: number;
  /** Author of the winning snapshot; a tombstone must match it. */
  authorPubkey: string;
  eventId: string;
};

export type AgentWikiPage = {
  kind: "agent";
  /** List/graph identity: the full `d` tag ("<space>/<slug>"). */
  key: string;
  d: string;
  space: string;
  slug: string;
  /** Body markdown with the standup front-matter block stripped. */
  content: string;
  frontMatter: StandupFrontMatter;
  provenance: WikiProvenance;
  updatedAt: number;
  authorPubkey: string;
  eventId: string;
};

export type WikiPage = HumanWikiPage | AgentWikiPage;

/** NIP-33 coordinate of a human wiki page (its tombstone's `a` tag target). */
export function humanPageCoordinate(
  authorPubkey: string,
  slug: string,
): string {
  return `${KIND_WIKI_PAGE}:${authorPubkey}:${slug}`;
}

/** Parse `44001:<pubkey>:<slug>`; null when the tag is not a page coordinate. */
export function parseHumanPageCoordinate(
  coordinate: string,
): { pubkey: string; slug: string } | null {
  const parts = coordinate.split(":");
  if (parts.length < 3) return null;
  const [kind, pubkey, ...rest] = parts;
  if (kind !== String(KIND_WIKI_PAGE)) return null;
  if (pubkey.length === 0 || rest.length === 0) return null;
  const slug = rest.join(":");
  if (slug.length === 0) return null;
  return { pubkey, slug };
}

function tagValue(event: WikiPageEvent, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return undefined;
}

/** Newest snapshot per slug candidate; null for a non-44001 event. */
export function eventToHumanWikiPage(
  event: WikiPageEvent,
): HumanWikiPage | null {
  if (event.kind !== KIND_WIKI_PAGE) return null;
  const slug = tagValue(event, "d") || event.id;
  return {
    kind: "human",
    key: slug,
    slug,
    content: typeof event.content === "string" ? event.content : "",
    updatedAt: event.created_at,
    authorPubkey: event.pubkey,
    eventId: event.id,
  };
}

/**
 * One kind:44002 revision folded into a page; null for other kinds or a `d`
 * that fails the `<space>/<slug>` grammar (the read side defends even though
 * the relay envelope already shape-checks at ingest).
 */
export function eventToAgentWikiPage(
  event: WikiPageEvent,
): AgentWikiPage | null {
  if (event.kind !== KIND_AGENT_WIKI_PAGE) return null;
  const d = tagValue(event, "d");
  if (!d) return null;
  const parsed = parseSpaceSlug(d);
  if (!parsed) return null;
  const frontMatter = parseFrontMatter(
    typeof event.content === "string" ? event.content : "",
  );
  return {
    kind: "agent",
    key: d,
    d,
    space: parsed.space,
    slug: parsed.slug,
    content: frontMatter.body,
    frontMatter,
    provenance: extractProvenance(event.tags),
    updatedAt: event.created_at,
    authorPubkey: event.pubkey,
    eventId: event.id,
  };
}

/** True when `candidate` supersedes `current` in the read-side LWW order. */
function supersedes(
  candidate: { updatedAt: number; eventId: string },
  current: { updatedAt: number; eventId: string },
): boolean {
  return (
    candidate.updatedAt > current.updatedAt ||
    (candidate.updatedAt === current.updatedAt &&
      candidate.eventId > current.eventId)
  );
}

/**
 * Index raw events (both wiki kinds plus tombstones) into the current page
 * set: human pages sorted by slug first, agent pages sorted by `d`.
 */
export function buildWikiPages(
  events: ReadonlyArray<WikiPageEvent>,
): WikiPage[] {
  // ── kind:44001: newest snapshot per slug, minus deleted pages ────────────
  const humanHeads = new Map<string, HumanWikiPage>();
  for (const event of events) {
    const page = eventToHumanWikiPage(event);
    if (!page) continue;
    const current = humanHeads.get(page.slug);
    if (!current || supersedes(page, current)) {
      humanHeads.set(page.slug, page);
    }
  }

  const tombstones = new Map<string, { pubkey: string; createdAt: number }>();
  for (const event of events) {
    if (event.kind !== KIND_DELETION) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "a") continue;
      const parsed = parseHumanPageCoordinate(tag[1] ?? "");
      if (!parsed) continue;
      const key = `${parsed.pubkey}:${parsed.slug}`;
      const previous = tombstones.get(key);
      if (!previous || event.created_at > previous.createdAt) {
        tombstones.set(key, {
          pubkey: event.pubkey,
          createdAt: event.created_at,
        });
      }
    }
  }

  const humans = [...humanHeads.values()]
    .filter((page) => {
      const tombstone = tombstones.get(`${page.authorPubkey}:${page.slug}`);
      if (!tombstone) return true;
      if (tombstone.pubkey !== page.authorPubkey) return true;
      return tombstone.createdAt < page.updatedAt;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // ── kind:44002: read-side LWW per (pubkey, d), then per d ────────────────
  const perAuthor = new Map<string, AgentWikiPage>();
  for (const event of events) {
    const page = eventToAgentWikiPage(event);
    if (!page) continue;
    const key = `${page.authorPubkey.toLowerCase()}|${page.d}`;
    const current = perAuthor.get(key);
    if (!current || supersedes(page, current)) {
      perAuthor.set(key, page);
    }
  }

  const winners = new Map<string, AgentWikiPage>();
  for (const page of perAuthor.values()) {
    const current = winners.get(page.d);
    if (!current || supersedes(page, current)) {
      winners.set(page.d, page);
    }
  }
  const agents = [...winners.values()].sort((a, b) => a.d.localeCompare(b.d));

  return [...humans, ...agents];
}

/**
 * `[[wikilinks]]` and `#tags` mentioned in wiki content, for the page-link
 * graph. A wikilink is a page name written by hand, so it normalises exactly
 * the way a kind:44001 slug does (see lib/slug.ts).
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
