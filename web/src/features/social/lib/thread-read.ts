/**
 * The reads behind a post's page, sized by what they cost the reader: every socket is a connection, a handshake and a
 * sign-in to a server that can be far away, so the thread is read in as few of them as the data allows. Alias-free so
 * `thread-read.test.mjs` counts the sockets the production function really opens.
 */

import { KIND_TEXT_NOTE } from "../../../shared/constants/kinds.ts";
import {
  queryEvents,
  queryEventsMulti,
} from "../../../shared/lib/nostr-client.ts";
import {
  buildRows,
  sortNewestFirst,
  type Row,
  type SignedEvent,
} from "./timeline.ts";

/** How many notes above the focused one are shown (and so the most the climb can read). */
export const MAX_ANCESTORS = 6;

const ROOT_REPLIES_LIMIT = 500;
const NOTE_REPLIES_LIMIT = 200;

export interface Thread {
  note: Row | null;
  /** The notes above `note`, oldest first. */
  ancestors: Row[];
  /** Every reply in the conversation, at every depth (the page builds the tree). */
  replies: Row[];
  isRoot: boolean;
}

/**
 * A note, the notes above it (oldest first) and every reply in its conversation: replies name the thread's first post
 * as their root, so one read by root finds them at every depth.
 *
 * Two reads on a reply, one on a top-level post, each a single REQ on a single socket: the note and the replies to it
 * together (the note's own tags are what name its root and parent, so they come first), then the replies by root and
 * the root and parent by id together. The climb above the note uses everything already read and goes back to the server
 * one note at a time only for a link that none of it holds (a parent the root read cut off, or one with no root tag),
 * never more than `MAX_ANCESTORS` times.
 */
export async function fetchThread(
  wsUrl: string,
  noteId: string,
): Promise<Thread> {
  const [found, repliesToNote] = await queryEventsMulti(wsUrl, [
    { ids: [noteId], kinds: [KIND_TEXT_NOTE], limit: 1 },
    { kinds: [KIND_TEXT_NOTE], "#e": [noteId], limit: ROOT_REPLIES_LIMIT },
  ]);
  const note = found[0]
    ? (buildRows([found[0] as SignedEvent])[0] ?? null)
    : null;
  const rootId = note?.rootId ?? noteId;
  const isRoot = note?.rootId == null;
  let underRoot = repliesToNote as SignedEvent[];
  let underNote: SignedEvent[] = [];
  const known = new Map<string, SignedEvent>();

  if (!isRoot) {
    // The first read held the replies to the note, which for a reply is the smaller of the two sets.
    underNote = sortNewestFirst(underRoot).slice(0, NOTE_REPLIES_LIMIT);
    const above = [...new Set([note?.replyToId, rootId])].filter(
      (id): id is string => !!id && id !== noteId,
    );
    const [byRoot, aboveNote] = await queryEventsMulti(wsUrl, [
      { kinds: [KIND_TEXT_NOTE], "#e": [rootId], limit: ROOT_REPLIES_LIMIT },
      { ids: above, kinds: [KIND_TEXT_NOTE], limit: above.length },
    ]);
    underRoot = byRoot as SignedEvent[];
    for (const event of aboveNote as SignedEvent[]) known.set(event.id, event);
  }
  for (const event of [...underRoot, ...underNote]) known.set(event.id, event);

  const ancestors: Row[] = [];
  let parentId = note?.replyToId ?? null;
  while (parentId && ancestors.length < MAX_ANCESTORS) {
    let parent = known.get(parentId);
    if (!parent) {
      [parent] = (await queryEvents(wsUrl, {
        ids: [parentId],
        kinds: [KIND_TEXT_NOTE],
        limit: 1,
      })) as SignedEvent[];
    }
    const row = parent ? buildRows([parent])[0] : null;
    if (!row) break;
    ancestors.unshift(row);
    parentId = row.replyToId;
  }

  const replies = buildRows([...underRoot, ...underNote]).filter(
    (r) => r.event.id !== noteId && r.replyToId !== null,
  );
  return { note, ancestors, replies, isRoot };
}
