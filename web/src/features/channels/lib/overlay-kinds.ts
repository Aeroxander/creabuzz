/**
 * Overlay kinds: they target a message with an `e` tag but are not replies to
 * it — a reaction shows as a pill on the message, an edit replaces its text, a
 * deletion marks it. Rendering them in the thread tree prints every reaction,
 * every edit (a duplicated message) and every deletion as a reply row.
 *
 * Alias-free; the removal rules in `moderator-removals.ts` use it under `node --test`.
 */
export const OVERLAY_KINDS = [7, 40003, 5, 9005]; // reactions, edits, deletions

export function isOverlayKind(kind: number): boolean {
  return OVERLAY_KINDS.includes(kind);
}
