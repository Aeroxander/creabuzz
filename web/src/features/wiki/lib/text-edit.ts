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
