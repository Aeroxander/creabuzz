/**
 * The server's notes in a room ("Board Tester created this room", "Reply Tester was added by Board Tester"), read
 * from their JSON body into one plain sentence.
 *
 * The wording follows the desktop's timeline rows (`SystemMessageRow`, `systemEventCopy`), except that this app says
 * "room" where the desktop still says "channel" (the web app calls them rooms everywhere people read). A type this app
 * does not know still gets a neutral line, never the raw body.
 *
 * Only a note the server signed is one: the server signs a room's metadata record with the same key, so a note from
 * any other key is someone's message and is shown as theirs. When that key is not known (`null`), every note counts.
 *
 * Alias-free; `system-notes.test.mjs` drives it under `node --test`.
 */

/** The record the server posts into a room when something about the room changes. */
export const KIND_SYSTEM_NOTE = 40099;

/** A note's body. The server writes JSON; every field but `type` is optional, and an unreadable body is type "". */
export interface SystemNote {
  type: string;
  actor?: string;
  target?: string;
  topic?: string;
  purpose?: string;
  visibility?: string;
  ttlSeconds?: number | null;
  publicReason?: string;
}

/** Whether `event` is a note from the server, given the server's key when it is known. */
export function isServerNote(
  event: { kind: number; pubkey: string },
  serverKey: string | null,
): boolean {
  if (event.kind !== KIND_SYSTEM_NOTE) return false;
  return serverKey === null || event.pubkey === serverKey;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

export function parseSystemNote(content: string): SystemNote {
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    return { type: "" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { type: "" };
  }
  const fields = body as Record<string, unknown>;
  const ttl = fields.ttl_seconds;
  return {
    type: stringField(fields, "type") ?? "",
    actor: stringField(fields, "actor"),
    target: stringField(fields, "target"),
    topic: stringField(fields, "topic"),
    purpose: stringField(fields, "purpose"),
    visibility: stringField(fields, "visibility"),
    ttlSeconds: typeof ttl === "number" ? ttl : ttl === null ? null : undefined,
    publicReason: stringField(fields, "public_reason"),
  };
}

export interface NoteNames {
  /** A person's name: their profile name, an agent's name, or a shortened key. */
  nameOf: (pubkey: string) => string;
  /** The reader, whose own name reads "You" at the start and "you" inside a sentence. */
  self?: string | null;
}

/** "3 days", "1 hour", "45 minutes": the cleanup delay in its largest whole unit. */
function spanOf(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function textChange(
  field: "topic" | "purpose",
  value: string | undefined,
): string {
  const trimmed = value?.trim();
  return trimmed
    ? `changed the ${field} to “${trimmed}”`
    : `cleared the ${field}`;
}

/** The note as one sentence, names resolved. */
export function systemNoteText(note: SystemNote, names: NoteNames): string {
  const isSelf = (pubkey: string | undefined) =>
    pubkey !== undefined &&
    names.self != null &&
    pubkey.toLowerCase() === names.self.toLowerCase();
  /** The name opening a sentence. */
  const subject = (pubkey: string | undefined) =>
    pubkey === undefined
      ? "Someone"
      : isSelf(pubkey)
        ? "You"
        : names.nameOf(pubkey);
  /** The name inside a sentence. */
  const object = (pubkey: string | undefined) =>
    pubkey === undefined
      ? "someone"
      : isSelf(pubkey)
        ? "you"
        : names.nameOf(pubkey);
  const actor = subject(note.actor);

  switch (note.type) {
    case "channel_created":
      return `${actor} created this room`;
    case "dm_created":
      return `${actor} started this chat`;
    case "member_joined":
      if (
        note.actor === undefined ||
        note.target === undefined ||
        note.actor.toLowerCase() === note.target.toLowerCase()
      ) {
        return `${subject(note.target ?? note.actor)} joined the room`;
      }
      return isSelf(note.target)
        ? `You were added by ${object(note.actor)}`
        : `${subject(note.target)} was added by ${object(note.actor)}`;
    case "member_left":
      return `${actor} left the room`;
    case "member_removed":
      return `${actor} removed ${object(note.target)} from the room`;
    case "admin_kick":
      return isSelf(note.target)
        ? "You were removed from the room"
        : `${subject(note.target)} was removed from the room`;
    case "topic_changed":
      return `${actor} ${textChange("topic", note.topic)}`;
    case "purpose_changed":
      return `${actor} ${textChange("purpose", note.purpose)}`;
    case "visibility_changed":
      if (note.visibility === "private" || note.visibility === "public") {
        return `${actor} made this room ${note.visibility}`;
      }
      return `${actor} changed who can see this room`;
    case "ttl_changed":
      return typeof note.ttlSeconds === "number" && note.ttlSeconds > 0
        ? `${actor} set this room to clean up after ${spanOf(note.ttlSeconds)} without activity`
        : `${actor} made this room permanent`;
    case "channel_archived":
      return `${actor} archived this room`;
    case "channel_unarchived":
      return `${actor} unarchived this room`;
    case "channel_auto_archived":
      return "This room was archived after a while without activity";
    case "channel_deleted":
      return `${actor} deleted this room`;
    case "message_deleted": {
      // A moderator's removal may carry a public reason; a plain delete carries none. The reporter is never named.
      const reason = note.publicReason?.trim();
      return reason
        ? `Removed by community moderators: ${reason}`
        : `${actor} removed a message`;
    }
    default:
      return note.actor === undefined
        ? "This room was updated"
        : `${actor} updated this room`;
  }
}

/**
 * The notes to leave out of a room's timeline: every "created this room" note after the first. A room is made once,
 * so a second one is a stray (a note that reached this room's list from somewhere else, or one sent twice) and reads as
 * two people making the same room. `ordered` is the timeline oldest first; `notes` the server's notes in it, by id.
 */
export function repeatedCreationNotes(
  ordered: readonly { id: string }[],
  notes: ReadonlyMap<string, SystemNote>,
): Set<string> {
  const hidden = new Set<string>();
  let seen = false;
  for (const event of ordered) {
    if (notes.get(event.id)?.type !== "channel_created") continue;
    if (seen) hidden.add(event.id);
    seen = true;
  }
  return hidden;
}
