/**
 * Whether private messages arrived since the reader last looked, for the dot on the Messages nav entry.
 *
 * The record is this browser's, per server and account: when it was first made (`since`; older messages never light
 * the dot, so a first visit is not a wall of "new"), when the inbox list was last on screen (`list`, the newest message
 * its previews showed), and per person when their conversation was last open (`peers`, the newest message it showed).
 * `list` and `peers` are the messages' own times, so a clock that differs from the sender's cannot make a read message
 * look new. `since` is this browser's clock: a message sent just after a first visit by someone whose clock runs slow
 * can fall before it and not light the dot.
 *
 * Alias-free; `messages-seen.test.mjs` drives it under `node --test`.
 */

export interface MessagesSeen {
  since: number;
  list: number;
  peers: Record<string, number>;
}

/** At most this many conversations are remembered; the ones read longest ago go first. */
export const MAX_SEEN_PEERS = 500;

const HEX64 = /^[0-9a-f]{64}$/;

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A new record: nothing before `now` counts as new. */
export function freshSeen(now: number): MessagesSeen {
  return { since: now, list: 0, peers: {} };
}

/** The record read back from the browser, or null when there is none (or it is not one). */
export function parseSeen(raw: string | null): MessagesSeen | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = value as {
    since?: unknown;
    list?: unknown;
    peers?: unknown;
  } | null;
  if (!record || !isTime(record.since)) return null;
  const peers: Record<string, number> = {};
  if (record.peers && typeof record.peers === "object") {
    for (const [peer, at] of Object.entries(record.peers)) {
      if (HEX64.test(peer) && isTime(at)) peers[peer] = at;
    }
  }
  return {
    since: record.since,
    list: isTime(record.list) ? record.list : 0,
    peers: capped(peers),
  };
}

function capped(peers: Record<string, number>): Record<string, number> {
  const entries = Object.entries(peers);
  if (entries.length <= MAX_SEEN_PEERS) return peers;
  return Object.fromEntries(
    entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN_PEERS),
  );
}

/** The inbox list showed messages up to `at`. Never moves back. */
export function withListSeen(seen: MessagesSeen, at: number): MessagesSeen {
  return at > seen.list ? { ...seen, list: at } : seen;
}

/** One conversation showed messages up to `at`. Never moves back. */
export function withPeerSeen(
  seen: MessagesSeen,
  peer: string,
  at: number,
): MessagesSeen {
  if (at <= (seen.peers[peer] ?? 0)) return seen;
  return { ...seen, peers: capped({ ...seen.peers, [peer]: at }) };
}

interface ConversationLike {
  peer: string;
  messages: readonly { from: string; at: number }[];
}

/** The newest message the other person sent in a conversation (0 when they sent none). */
export function newestIncoming(conversation: ConversationLike): number {
  let newest = 0;
  for (const message of conversation.messages) {
    if (message.from === conversation.peer && message.at > newest)
      newest = message.at;
  }
  return newest;
}

/** The newest message anyone else sent across these conversations (0 when none). */
export function newestIncomingOf(
  conversations: readonly ConversationLike[],
): number {
  return conversations.reduce(
    (newest, conversation) => Math.max(newest, newestIncoming(conversation)),
    0,
  );
}

/**
 * Some conversation has a message from the other person newer than the reader last saw it, in the list or in the
 * conversation. Without a record nothing is new: it is not known what was read.
 */
export function hasUnreadMessages(
  conversations: readonly ConversationLike[],
  seen: MessagesSeen | null,
): boolean {
  if (!seen) return false;
  return conversations.some(
    (conversation) =>
      newestIncoming(conversation) >
      Math.max(seen.since, seen.list, seen.peers[conversation.peer] ?? 0),
  );
}
