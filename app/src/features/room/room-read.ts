/**
 * A project's holder room, built from what one read of its tag returned (plan sections 4.1 and 7.6). Pure.
 *
 * The room is read by its tag only. Every event is checked again here against the project's coordinate and the room's key:
 * an event that does not carry exactly this room's tags is not in the room, whatever the server sent. Replies hang under their
 * root post and are never read by `#e`, so an untagged event can never show in a thread. A person the reader hid is left out
 * everywhere, and so are the replies to a post that is not on screen.
 */
import {
  computeEngagement,
  NO_ENGAGEMENT,
} from "@creaton/core/social/engagement.ts";
import { parseNote, roomKeyOf } from "@creaton/core/social/feed/feed-events.ts";
import type { Engagement, SignedEvent } from "../posts/use-posts";

/** How many top-level posts the room shows at first, and each time "Show earlier posts" is pressed. */
export const PAGE = 30;

interface RoomPost {
  event: SignedEvent;
  engagement: Engagement;
  /** Replies, oldest first. */
  replies: { event: SignedEvent; engagement: Engagement }[];
}

export interface RoomView {
  /** Newest first. */
  posts: RoomPost[];
  /** How many top-level posts were read in all (some may be past the page). */
  total: number;
}

/** Whether `event` belongs to this room: the project's `a` tag once, and this room's tag. */
export function isOfRoom(
  event: { tags: readonly string[][] },
  coordinate: string,
  key: string,
): boolean {
  const as = event.tags.filter((t) => t[0] === "a");
  return as.length === 1 && as[0][1] === coordinate && roomKeyOf(event) === key;
}

const newest = (a: SignedEvent, b: SignedEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : -1);

/** The room from its posts (kind 1) and likes (kind 7), for the viewer `me`, without the people in `hidden`. */
export function buildRoom(input: {
  notes: readonly SignedEvent[];
  likes: readonly SignedEvent[];
  coordinate: string;
  key: string;
  me: string | null;
  hidden: ReadonlySet<string>;
}): RoomView {
  const { coordinate, key, hidden } = input;
  const keep = (e: SignedEvent) =>
    isOfRoom(e, coordinate, key) && !hidden.has(e.pubkey.toLowerCase());
  const notes = input.notes.filter(keep);
  const likes = input.likes.filter(keep);
  const tops: SignedEvent[] = [];
  const replies: SignedEvent[] = [];
  for (const note of notes) {
    const parsed = parseNote(note);
    if (!parsed) continue;
    (parsed.rootId === null ? tops : replies).push(note);
  }
  const topIds = new Set(tops.map((t) => t.id));
  // A reply counts only under a root that is on screen; one whose root is hidden or not read has nowhere to hang.
  const underRoot = replies.filter((r) => {
    const root = parseNote(r)?.rootId;
    return root !== null && root !== undefined && topIds.has(root);
  });
  const shown = new Set<string>([...tops, ...underRoot].map((e) => e.id));
  const engagement = computeEngagement(
    [...shown],
    [...likes, ...underRoot],
    input.me,
  );
  const by = (e: SignedEvent) => engagement.get(e.id) ?? NO_ENGAGEMENT;
  const posts = [...tops].sort(newest).map((event) => ({
    event,
    engagement: by(event),
    replies: underRoot
      .filter((r) => parseNote(r)?.rootId === event.id)
      .sort((a, b) => -newest(a, b))
      .map((reply) => ({ event: reply, engagement: by(reply) })),
  }));
  return { posts, total: posts.length };
}
