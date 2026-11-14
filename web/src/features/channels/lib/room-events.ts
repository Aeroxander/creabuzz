/**
 * The events that make up one room's timeline, in the order they are shown.
 *
 * Only events kept under this room (its `h` tag) belong in it: the live and older-page lists outlive a switch from one
 * room to the next, so without this check a note from the room open a moment ago ("Dev created this channel") showed in
 * the next one. Oldest first; within the same second the room's "created" note goes first, because nothing can happen in
 * a room before it exists.
 *
 * Alias-free; `room-events.test.mjs` drives it under `node --test`.
 */

import { KIND_SYSTEM_NOTE } from "./system-notes.ts";

interface RoomEvent {
  id: string;
  kind: number;
  created_at: number;
  tags: readonly (readonly string[])[];
  content: string;
}

function roomOf(event: RoomEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === "h")?.[1];
}

function isCreationNote(event: RoomEvent): boolean {
  if (event.kind !== KIND_SYSTEM_NOTE) return false;
  try {
    const body: unknown = JSON.parse(event.content);
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { type?: unknown }).type === "channel_created"
    );
  } catch {
    return false;
  }
}

/** This room's events, one per id, in timeline order. */
export function roomTimeline<E extends RoomEvent>(
  events: Iterable<E>,
  roomId: string,
): E[] {
  const byId = new Map<string, E>();
  for (const event of events) {
    if (roomOf(event) === roomId) byId.set(event.id, event);
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.created_at - b.created_at ||
      Number(isCreationNote(b)) - Number(isCreationNote(a)),
  );
}
