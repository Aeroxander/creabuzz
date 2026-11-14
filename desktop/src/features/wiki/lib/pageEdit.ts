/**
 * Pure edit/apply logic for desktop wiki-page editing.
 *
 * The web client's `text-edit.ts` / `wiki-doc.ts` are the reference for how a
 * local edit is expressed and applied against a page's text. The desktop has no
 * live CRDT document (editing is single-user here), so this module carries the
 * reusable pure core of that logic — the minimal-replacement diff and its
 * clamped application — plus the save event shape, so a desktop edit publishes
 * byte-for-byte the same record the web client does (`kind:44001`, `d` = slug,
 * content = markdown).
 *
 * Alias-free on purpose: `pageEdit.test.mjs` drives it under `node --test`.
 */

/** The team page kind (human wiki) — the only kind desktop may edit. */
export const KIND_WIKI_PAGE = 44001;

/** A single contiguous replacement: `deleteCount` chars at `index` → `insert`. */
export interface TextEdit {
  index: number;
  deleteCount: number;
  insert: string;
}

/**
 * The smallest replacement that turns `before` into `after` (common prefix +
 * suffix trimmed). Mirrors the web client's `diffEdit`.
 */
export function diffEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    index: prefix,
    deleteCount: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Apply an edit to a plain string, clamping the range to what the text still
 * has (the desktop's `applyEdit`, without a live document).
 */
export function applyTextEdit(text: string, edit: TextEdit): string {
  const index = Math.max(0, Math.min(edit.index, text.length));
  const deleteCount = Math.max(
    0,
    Math.min(edit.deleteCount, text.length - index),
  );
  return text.slice(0, index) + edit.insert + text.slice(index + deleteCount);
}

/** The event template the desktop signs and publishes to save a team page. */
export interface PageSavePayload {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

/**
 * Build the save payload for a team page: `kind:44001`, `d` = slug, content =
 * markdown — the same event shape the web client publishes. When the page
 * carries a team scope, its `t: team:<id>` tag is preserved so an edit never
 * silently re-scopes who may edit the page next.
 */
export function buildPageSavePayload(opts: {
  slug: string;
  content: string;
  now: number;
  scope?: string | null;
}): PageSavePayload {
  const tags: string[][] = [["d", opts.slug]];
  if (opts.scope) tags.push(["t", `team:${opts.scope}`]);
  return {
    kind: KIND_WIKI_PAGE,
    tags,
    content: opts.content,
    created_at: opts.now,
  };
}

/**
 * The delete-marker payload: `kind:5` naming the page's coordinate. `purge:
 * true` adds the `["purge","1"]` tag — the relay's PERMANENT delete, accepted
 * from community admins only; every other delete is a restorable tombstone.
 * A non-admin asking for a purge is refused loudly instead of silently
 * publishing a restorable delete in its place (authors can never purge).
 */
export interface DeleteMarkerPayload {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

export const KIND_DELETION = 5;

export function buildDeleteMarkerPayload(opts: {
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
    kind: KIND_DELETION,
    tags,
    content: "",
    created_at: opts.now,
  };
}

/**
 * The team-scope edit gate, mirroring the relay rule exactly: unscoped pages
 * are open to members; scoped pages need a team seat or admin; a scoped page
 * whose team is unresolvable (or seatless) is read-only for ordinary members —
 * no open-editing fallback the relay would reject. Admins can re-scope.
 */
export function canEditWikiPage(input: {
  scope: string | null;
  resolveTeamSeats: (teamId: string) => string[] | null;
  viewerPubkey: string | null;
  viewerIsAdmin: boolean;
}): boolean {
  if (!input.scope) return true;
  const holders = input.resolveTeamSeats(input.scope);
  if (holders == null || holders.length === 0) return input.viewerIsAdmin;
  if (input.viewerPubkey && holders.includes(input.viewerPubkey)) return true;
  return input.viewerIsAdmin;
}
