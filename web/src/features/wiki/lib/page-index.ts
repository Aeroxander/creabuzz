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
  /** The `t: team:<id>` scope the winning snapshot carried, or null. */
  scope: string | null;
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
 * A NIP-09 tombstone (`kind:5`) naming a page's `a` coordinate comes in two
 * flavours, mirroring the relay's delete contract exactly:
 *
 * - a marker carrying `["purge","1"]` (community admins only — the relay
 *   rejects it from anyone else) is a PERMANENT purge: the page never returns;
 * - any other authorized delete is a RESTORABLE tombstone: the page is hidden
 *   until an authorized editor publishes a newer accepted revision, which
 *   restores it (the restore path is just a normal revision).
 *
 * Deletion authority: the marker must be signed by the coordinate's own
 * author who actually published the page (a tombstone naming one's own
 * coordinate of a page one never authored is ignored), or carry the purge tag
 * (admin authority, already enforced at the relay).
 */
export function buildPages(events: IndexEvent[]): IndexedPage[] {
  const folded = foldPages(events);
  return folded.live.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** One page's deletion record, for "Recently deleted". */
export interface TombstonedPage {
  slug: string;
  /** Content of the last live revision — what a restore republishes. */
  content: string;
  /** Author of the last live revision. */
  authorPubkey: string;
  /** When the page was deleted. */
  deletedAt: number;
  /** Who signed the tombstone. */
  deletedBy: string;
  /** The `t: team:<id>` scope the last live revision carried, or null. */
  scope: string | null;
}

/** Bound the Recently-deleted list; the query itself is bounded too. */
export const TOMBSTONE_LIST_LIMIT = 50;

/**
 * Pages currently hidden by a RESTORABLE tombstone — the "Recently deleted"
 * list. Purged pages are gone from the server and never appear here. Newest
 * deletion first, bounded to {@link TOMBSTONE_LIST_LIMIT}.
 */
export function buildTombstonedPages(events: IndexEvent[]): TombstonedPage[] {
  return foldPages(events)
    .tombstoned.sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, TOMBSTONE_LIST_LIMIT);
}

/** The delete-marker payload a caller signs to delete (or purge) a page. */
export interface DeleteMarkerPayload {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

/**
 * Build the delete-marker payload for a page's coordinate.
 *
 * `purge: true` adds the `["purge","1"]` tag and is ADMINS ONLY — authors can
 * never purge. A non-admin asking for a purge is a permission error the UI's
 * role gate should have prevented; failing loudly here keeps a mis-wired call
 * from silently publishing a restorable delete in its place.
 */
export function buildDeleteMarker(opts: {
  coordinate: string;
  purge: boolean;
  viewerIsAdmin: boolean;
  now: number;
}): DeleteMarkerPayload {
  if (opts.purge && !opts.viewerIsAdmin) {
    throw new Error("only a community admin can delete a page permanently");
  }
  const tags: string[][] = [["a", opts.coordinate]];
  if (opts.purge) tags.push(["purge", "1"]);
  return {
    kind: KIND_DELETE,
    tags,
    content: "",
    created_at: opts.now,
  };
}

type Marker = { at: number; signer: string; purge: boolean };

interface Folded {
  live: IndexedPage[];
  tombstoned: TombstonedPage[];
}

function scopeOf(event: IndexEvent): string | null {
  for (const tag of event.tags) {
    if (tag[0] !== "t") continue;
    const value = typeof tag[1] === "string" ? tag[1] : "";
    if (value.startsWith("team:") && value.length > 5) return value.slice(5);
  }
  return null;
}

function foldPages(events: IndexEvent[]): Folded {
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
      scope: scopeOf(event),
    };
    const list = revisions.get(slug);
    if (list) list.push(page);
    else revisions.set(slug, [page]);
    const set = authors.get(slug);
    if (set) set.add(event.pubkey);
    else authors.set(slug, new Set([event.pubkey]));
  }

  // Effective tombstones per slug: kind:5 naming a 44001 coordinate of the
  // slug, signed by that coordinate's author who published the page — or
  // carrying the purge tag (admin authority, enforced at the relay).
  const markers = new Map<string, Marker[]>();
  for (const event of events) {
    if (event.kind !== KIND_DELETE) continue;
    const purge = event.tags.some(
      (tag) => tag[0] === "purge" && tag[1] === "1",
    );
    for (const tag of event.tags) {
      if (tag[0] !== "a") continue;
      const parsed = parsePageCoordinate(tag[1] ?? "");
      if (!parsed) continue;
      if (!purge) {
        if (event.pubkey !== parsed.pubkey) continue;
        if (!authors.get(parsed.slug)?.has(event.pubkey)) continue;
      }
      const list = markers.get(parsed.slug);
      const marker = { at: event.created_at, signer: event.pubkey, purge };
      if (list) list.push(marker);
      else markers.set(parsed.slug, [marker]);
    }
  }

  // Fold each slug in (created_at, revision-before-marker at ties) order, so
  // a tombstone at the same timestamp still hides the page.
  const live: IndexedPage[] = [];
  const tombstoned: TombstonedPage[] = [];
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
        markerData: m,
      })),
    ].sort((x, y) => x.at - y.at || Number(x.marker) - Number(y.marker));
    let current: IndexedPage | null = null;
    let deleted: Marker | null = null;
    let lastLive: IndexedPage | null = null;
    for (const step of steps) {
      if (step.marker) {
        deleted = step.markerData;
        current = null;
      } else if (!deleted) {
        if (!current || step.page.updatedAt > current.updatedAt) {
          current = step.page;
          lastLive = step.page;
        }
      } else if (!deleted.purge && step.page.updatedAt > deleted.at) {
        // A restorable tombstone: any newer accepted revision (the relay
        // checks the editor's authority) restores the page.
        deleted = null;
        current = step.page;
        lastLive = step.page;
      }
    }
    if (current) {
      live.push(current);
    } else if (deleted && !deleted.purge && lastLive) {
      tombstoned.push({
        slug,
        content: lastLive.content,
        authorPubkey: lastLive.authorPubkey,
        deletedAt: deleted.at,
        deletedBy: deleted.signer,
        scope: lastLive.scope,
      });
    }
  }
  return { live, tombstoned };
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
