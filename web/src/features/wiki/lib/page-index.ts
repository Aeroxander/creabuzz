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
  /** Event id of the winning snapshot — also the live-edit seed key. */
  id: string;
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
 * A NIP-09 tombstone naming a page author's coordinate (signed by that
 * author) deletes THE PAGE: every revision by every member, not just the
 * newest author's. Deletion is sticky — a later revision by another member
 * (a stale editor auto-saving, say) must not resurrect a deleted page — and
 * only the deleting author can bring their own page back with a newer
 * revision. A tombstone naming one's own coordinate of a page one never
 * authored is ignored: deletion authority is the page's authors.
 */
export function buildPages(events: IndexEvent[]): IndexedPage[] {
  // Revisions per slug plus the set of authors per slug (deletion authority).
  const revisions = new Map<string, IndexedPage[]>();
  const authors = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== KIND_WIKI_PAGE) continue;
    const slug = tagValue(event, "d") ?? event.id;
    const page: IndexedPage = {
      id: event.id,
      slug,
      content: typeof event.content === "string" ? event.content : "",
      updatedAt: event.created_at,
      authorPubkey: event.pubkey,
    };
    const list = revisions.get(slug);
    if (list) list.push(page);
    else revisions.set(slug, [page]);
    const set = authors.get(slug);
    if (set) set.add(event.pubkey);
    else authors.set(slug, new Set([event.pubkey]));
  }

  // Valid tombstones per slug: kind:5 naming a 44001 coordinate of the slug,
  // signed by that coordinate's author, where the author has actually
  // published the page.
  const markers = new Map<string, { at: number; signer: string }[]>();
  for (const event of events) {
    if (event.kind !== KIND_DELETE) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "a") continue;
      const parsed = parsePageCoordinate(tag[1] ?? "");
      if (!parsed) continue;
      if (event.pubkey !== parsed.pubkey) continue;
      if (!authors.get(parsed.slug)?.has(event.pubkey)) continue;
      const list = markers.get(parsed.slug);
      const marker = { at: event.created_at, signer: event.pubkey };
      if (list) list.push(marker);
      else markers.set(parsed.slug, [marker]);
    }
  }

  // Fold each slug in (created_at, revision-before-marker at ties) order, so
  // a tombstone at the same timestamp still hides the page.
  const pages: IndexedPage[] = [];
  for (const [slug, revs] of revisions) {
    const steps = [
      ...revs.map((page) => ({
        at: page.updatedAt,
        marker: false as const,
        page,
      })),
      ...(markers.get(slug) ?? []).map((m) => ({
        at: m.at,
        marker: true as const,
        page: null,
        signer: m.signer,
      })),
    ].sort((x, y) => x.at - y.at || Number(x.marker) - Number(y.marker));
    let current: IndexedPage | null = null;
    let deleted: { at: number; signer: string } | null = null;
    for (const step of steps) {
      if (step.marker) {
        deleted = { at: step.at, signer: step.signer };
        current = null;
      } else if (!deleted) {
        if (!current || step.page.updatedAt > current.updatedAt) {
          current = step.page;
        }
      } else if (
        step.page.authorPubkey === deleted.signer &&
        step.at > deleted.at
      ) {
        // The deleting author recreated their own page.
        deleted = null;
        current = step.page;
      }
    }
    if (current) pages.push(current);
  }
  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Whether this viewer may delete this page.
 *
 * The relay only accepts a delete marker from the newest revision's author
 * ("must be event author"), so anyone else's attempt fails after the fact —
 * the button must not offer it. A draft exists only in this editor, so
 * discarding it is local and always allowed.
 */
export function canDeletePage(
  page: { draft?: boolean; authorPubkey?: string } | null | undefined,
  viewerPubkey: string | null,
): boolean {
  if (!page) return false;
  if (page.draft) return true;
  return viewerPubkey != null && viewerPubkey === page.authorPubkey;
}
