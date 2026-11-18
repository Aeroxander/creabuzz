/**
 * Local-edit splicing for the shared wiki document.
 *
 * `useLiveWikiDoc` receives the whole document on every editor change, but the
 * peer-to-peer document is a CRDT that other peers keep writing to. Replacing it
 * wholesale wipes whatever arrived since the editor last rendered — the bug this
 * module exists to prevent.
 *
 * A local change is therefore expressed as a delta against the text the user
 * actually saw, and spliced into the live document:
 *
 * - no drift (the common case): the delta is applied verbatim;
 * - drifted, but the delta only inserts: safe — insertions never remove peer text;
 * - drifted, and the delta replaces text that is still identical in the live
 *   document: safe — the peer's changes lie outside the edited range;
 * - drifted, and the delta replaces text a peer already rewrote: unresolvable
 *   without a CRDT-aware editor binding, so it falls back to the new value.
 *
 * Alias-free on purpose: `text-edit.test.mjs` drives it under `node --test`.
 */

import type * as Y from "yjs";

/** A single contiguous replacement: `deleteCount` chars at `index` → `insert`. */
export interface TextEdit {
  index: number;
  deleteCount: number;
  insert: string;
}

/** Result of committing a local edit into a live document. */
export type CommitResult = "noop" | "applied" | "replaced";

/** Smallest replacement that turns `before` into `after` (common prefix+suffix). */
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

/** Apply an edit to a Y.Text, clamping the range to what the text still has. */
export function applyEdit(text: Y.Text, edit: TextEdit): void {
  const length = text.length;
  const index = Math.max(0, Math.min(edit.index, length));
  const deleteCount = Math.max(0, Math.min(edit.deleteCount, length - index));
  if (deleteCount > 0) text.delete(index, deleteCount);
  if (edit.insert.length > 0) text.insert(index, edit.insert);
}

/**
 * Splice one local editor value into the live document.
 *
 * `rendered` is the string the editor last displayed; `value` is what it now
 * holds. Returns how the edit was resolved so callers can observe the fallback.
 */
export function commitLocalEdit(
  text: Y.Text,
  rendered: string,
  value: string,
): CommitResult {
  const live = text.toString();
  if (live === value) return "noop";

  const edit = diffEdit(rendered, value);
  if (!edit) return "noop";

  if (live === rendered) {
    applyEdit(text, edit);
    return "applied";
  }

  // The document moved on. An insertion adds to the peer's text instead of
  // replacing it, so it is always safe to place.
  if (edit.deleteCount === 0) {
    applyEdit(text, edit);
    return "applied";
  }

  // A replacement is safe only while the text it overwrites is untouched.
  const replacedInLive = live.slice(edit.index, edit.index + edit.deleteCount);
  const replacedInRendered = rendered.slice(
    edit.index,
    edit.index + edit.deleteCount,
  );
  if (edit.index <= live.length && replacedInLive === replacedInRendered) {
    applyEdit(text, edit);
    return "applied";
  }

  // Unresolvable overlap: keep the user's draft and accept the peer's loss.
  applyEdit(text, { index: 0, deleteCount: live.length, insert: value });
  return "replaced";
}

// ── snapshot seeding ────────────────────────────────────────────────────────

/**
 * Deterministic seeding of a saved snapshot into a fresh document.
 *
 * Two browsers opening the same saved page each insert its text locally
 * before any peer sync. Yjs treats inserts made under different client ids as
 * independent text, so once the peers exchange state the page reads TWICE.
 * Seeding under a client id derived from the saved snapshot's event id makes
 * both inserts the same items — identical (client, clock) ids — which Yjs
 * deduplicates on sync: one copy of the snapshot plus everyone's live edits.
 *
 * The document is rekeyed back to its own random client id straight after the
 * seed: live edits must NOT share a client id (two concurrently editing peers
 * minting items with the same (client, clock) ids would collide), only the
 * identical seed insert may.
 */

/**
 * FNV-1a over `seedKey`, folded to a non-zero Yjs client id (uint32). The
 * same saved snapshot therefore seeds under the same client id everywhere.
 */
export function seedClientId(seedKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seedKey.length; i++) {
    hash ^= seedKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 1;
}

/**
 * Insert `content` as a fresh document's seed snapshot under the
 * deterministic client id for `seedKey` (the saved snapshot's event id), then
 * hand the document back its own random client id for live edits. No-op on a
 * non-empty document or empty content.
 */
export function seedSnapshot(
  text: Y.Text,
  content: string,
  seedKey: string,
): void {
  if (content.length === 0 || text.length > 0) return;
  const doc = text.doc;
  if (!doc) return;
  const own = doc.clientID;
  doc.clientID = seedClientId(seedKey);
  doc.transact(() => {
    text.insert(0, content);
  }, doc.clientID);
  doc.clientID = own;
}
