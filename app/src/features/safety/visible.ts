/**
 * Which posts a person sees. One rule for every list that is not a room (a search, a hashtag, saved posts), so none of them
 * can show what Home, a profile or the room would hide: a post of a holder room is read in that room only, and a post by
 * someone the reader hid, or a post the reader reported, is hidden for them. Pure.
 */
import { inAnyRoom } from "@creaton/core/social/feed/feed-events.ts";

export interface HideRules {
  /** People this reader hid (lower-case keys). */
  muted: ReadonlySet<string>;
  /** Posts this reader reported (ids). */
  reported: ReadonlySet<string>;
}

export type WhyHidden = "room" | "muted" | "reported";

interface PostLike {
  id: string;
  pubkey: string;
  tags: readonly string[][];
}

/** Why `post` is not shown to this reader, or null when it is. */
export function whyHidden(post: PostLike, rules: HideRules): WhyHidden | null {
  if (inAnyRoom(post)) return "room";
  if (rules.muted.has(post.pubkey.toLowerCase())) return "muted";
  if (rules.reported.has(post.id)) return "reported";
  return null;
}

/**
 * The posts the reader sees, in the order given, and how many were left out because the reader hid the person or reported the
 * post. A room's posts are not counted: they were never part of a list like this one.
 */
export function visiblePosts<T extends PostLike>(
  posts: readonly T[],
  rules: HideRules,
): { shown: T[]; hidden: number } {
  const shown: T[] = [];
  let hidden = 0;
  for (const post of posts) {
    const why = whyHidden(post, rules);
    if (why === null) shown.push(post);
    else if (why !== "room") hidden += 1;
  }
  return { shown, hidden };
}
