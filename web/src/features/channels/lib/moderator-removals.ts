/**
 * Which chat messages a room's moderators have taken away, as one reader should see them.
 *
 * Someone who owns or administers a room (or the community) can remove another person's message. The server stores that
 * removal only when the sender may do it and then deletes the message for everyone, so a reader who reloads never gets it
 * back. A reader who has the room open sees the removal arrive live; it is applied here only when its sender is a known
 * owner or admin, only to someone else's message, and never to a reaction, an edit or another deletion. A removal stays in
 * force for the reader if that moderator's role is withdrawn afterwards.
 *
 * Alias-free; `moderator-removals.test.mjs` drives it under `node --test`.
 */

import { isOverlayKind } from "./overlay-kinds.ts";

/** The signed record that removes someone else's message from a room. */
const KIND_MODERATION_DELETE = 9005;

export interface TimelineEvent {
  id: string;
  pubkey: string;
  kind: number;
  tags: readonly (readonly string[])[];
}

/** Every removal in `events` of a message by someone else that is itself in `events`. */
function removalsOfOthers(
  events: readonly TimelineEvent[],
): { sender: string; target: string }[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const found: { sender: string; target: string }[] = [];
  for (const event of events) {
    if (event.kind !== KIND_MODERATION_DELETE) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "e" || typeof tag[1] !== "string") continue;
      const target = byId.get(tag[1]);
      if (!target || isOverlayKind(target.kind)) continue;
      if (target.pubkey === event.pubkey) continue;
      found.push({ sender: event.pubkey, target: target.id });
    }
  }
  return found;
}

/** Ids a removal from one of `removers` takes away. */
export function removedByModerators(
  events: readonly TimelineEvent[],
  removers: ReadonlySet<string>,
): Set<string> {
  return new Set(
    removalsOfOthers(events)
      .filter(({ sender }) => removers.has(sender))
      .map(({ target }) => target),
  );
}

/**
 * Who sent a removal without being a known owner or admin. Their removal is not applied, but the roster may be out of date
 * (someone was appointed after it was read), so the caller reads it again when this list changes. Sorted, without repeats.
 */
export function unfamiliarRemovers(
  events: readonly TimelineEvent[],
  removers: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      removalsOfOthers(events)
        .filter(({ sender }) => !removers.has(sender))
        .map(({ sender }) => sender),
    ),
  ].sort();
}

/**
 * What moderators have removed so far, remembered: a removal accepted from someone who was an owner or admin then, stays in
 * force if their role is withdrawn. Returns `previous` itself when nothing was added.
 */
export function keepRemovals(
  previous: ReadonlySet<string>,
  events: readonly TimelineEvent[],
  removers: ReadonlySet<string>,
): ReadonlySet<string> {
  const now = removedByModerators(events, removers);
  if ([...now].every((id) => previous.has(id))) return previous;
  return new Set([...previous, ...now]);
}
