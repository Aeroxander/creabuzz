/**
 * Wiki page indexing: latest snapshot per slug, minus deleted pages.
 *
 * Pages are NIP-33 addressable events (`kind:44001`, `d` = slug). A page is
 * removed with a NIP-09 tombstone (`kind:5`) carrying the page's `a`
 * coordinate; the relay keeps the tombstone, so every client hides the page
 * without the relay needing delete semantics for addressable events.
 *
 * Alias-free so `page-index.test.mjs` can drive it under `node --test`.
 */

export const KIND_WIKI_PAGE = 44001;
export const KIND_DELETE = 5;

/** The subset of a Nostr event this index needs. */
export interface IndexEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface IndexedPage {
  slug: string;
  content: string;
  updatedAt: number;
  authorPubkey: string;
}

/** NIP-33 coordinate of a wiki page. */
export function pageCoordinate(authorPubkey: string, slug: string): string {
  return `${KIND_WIKI_PAGE}:${authorPubkey}:${slug}`;
}

function tagValue(event: IndexEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/** Parse `44001:<pubkey>:<slug>`; null when the tag is not a page coordinate. */
export function parsePageCoordinate(
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

/**
 * Index raw events into the current page set.
 *
 * A tombstone hides a page only when it is signed by that page's author and was
 * published at or after the page — anyone else's tombstone is ignored, and a
 * page republished after a delete reappears.
 */
export function buildPages(events: IndexEvent[]): IndexedPage[] {
  const latest = new Map<string, IndexedPage>();
  for (const event of events) {
    if (event.kind !== KIND_WIKI_PAGE) continue;
    const slug = tagValue(event, "d") ?? event.id;
    const page: IndexedPage = {
      slug,
      content: typeof event.content === "string" ? event.content : "",
      updatedAt: event.created_at,
      authorPubkey: event.pubkey,
    };
    const previous = latest.get(slug);
    if (!previous || event.created_at > previous.updatedAt) {
      latest.set(slug, page);
    }
  }

  const tombstones = new Map<string, { pubkey: string; createdAt: number }>();
  for (const event of events) {
    if (event.kind !== KIND_DELETE) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "a") continue;
      const parsed = parsePageCoordinate(tag[1] ?? "");
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

  return [...latest.values()]
    .filter((page) => {
      const tombstone = tombstones.get(`${page.authorPubkey}:${page.slug}`);
      if (!tombstone) return true;
      if (tombstone.pubkey !== page.authorPubkey) return true;
      return tombstone.createdAt < page.updatedAt;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
