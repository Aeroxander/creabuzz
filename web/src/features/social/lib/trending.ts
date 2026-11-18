/**
 * Discovery signals computed from what the relay already holds: trending
 * notes, trending hashtags and the most-followed accounts. Pure and
 * alias-free: `social.test.mjs` drives it under `node --test`.
 */

import {
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import {
  extractTopics,
  parseNote,
  type SignedEventLike,
} from "../../feed/lib/feed-events.ts";
import { lastTagValue, tagValues } from "./engagement.ts";

const LIKE_WEIGHT = 1;
const REPOST_WEIGHT = 2;
const REPLY_WEIGHT = 2;

/** Engagement score per note id: likes + 2×reposts + 2×replies. */
export function scoreNotes(
  events: readonly SignedEventLike[],
): Map<string, number> {
  const scores = new Map<string, number>();
  const seen = new Set<string>();
  const bump = (id: string | null | undefined, by: number) => {
    if (id) scores.set(id, (scores.get(id) ?? 0) + by);
  };
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.kind === KIND_REACTION && (e.content === "+" || e.content === "")) {
      bump(lastTagValue(e.tags, "e"), LIKE_WEIGHT);
    } else if (e.kind === KIND_REPOST) {
      bump(lastTagValue(e.tags, "e"), REPOST_WEIGHT);
    } else if (e.kind === KIND_TEXT_NOTE) {
      bump(parseNote(e)?.replyToId, REPLY_WEIGHT);
    }
  }
  return scores;
}

export function topIds(
  scores: ReadonlyMap<string, number>,
  limit: number,
): string[] {
  return [...scores]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([id]) => id);
}

/** Most-used hashtags, counted once per author per tag. */
export function trendingHashtags(
  notes: readonly SignedEventLike[],
  limit: number,
): { tag: string; count: number }[] {
  const authorsByTag = new Map<string, Set<string>>();
  for (const e of notes) {
    if (e.kind !== KIND_TEXT_NOTE) continue;
    const tags = new Set([
      ...tagValues(e.tags, "t").map((t) => t.toLowerCase()),
      ...extractTopics(e.content),
    ]);
    for (const tag of tags) {
      const authors = authorsByTag.get(tag) ?? new Set<string>();
      authors.add(e.pubkey);
      authorsByTag.set(tag, authors);
    }
  }
  return [...authorsByTag]
    .map(([tag, authors]) => ({ tag, count: authors.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

/** Accounts followed by the most people, minus `exclude` (you and who you follow). */
export function mostFollowed(
  contactLists: readonly SignedEventLike[],
  exclude: ReadonlySet<string>,
  limit: number,
): { pubkey: string; followers: number }[] {
  const latest = new Map<string, SignedEventLike>();
  for (const e of contactLists) {
    const prev = latest.get(e.pubkey);
    if (!prev || prev.created_at < e.created_at) latest.set(e.pubkey, e);
  }
  const counts = new Map<string, number>();
  for (const e of latest.values()) {
    for (const pk of tagValues(e.tags, "p")) {
      if (pk !== e.pubkey && !exclude.has(pk)) {
        counts.set(pk, (counts.get(pk) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .map(([pubkey, followers]) => ({ pubkey, followers }))
    .sort((a, b) => b.followers - a.followers || (a.pubkey < b.pubkey ? -1 : 1))
    .slice(0, limit);
}
