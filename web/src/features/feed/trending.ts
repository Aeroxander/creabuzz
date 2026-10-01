import type { NostrEvent } from "@/shared/lib/nostr-client";
import {
  KIND_NOTE,
  KIND_REACTION,
  KIND_REPOST,
  hashtagsOf,
  lastTagValue,
  parentIdOf,
  tagValues,
} from "./feed-model";

const LIKE_WEIGHT = 1;
const REPOST_WEIGHT = 2;
const REPLY_WEIGHT = 2;

/** Engagement score per note id from recent likes, reposts and replies. */
export function scoreNotes(events: NostrEvent[]): Map<string, number> {
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
    } else if (e.kind === KIND_NOTE) {
      bump(parentIdOf(e), REPLY_WEIGHT);
    }
  }
  return scores;
}

export function topIds(scores: Map<string, number>, limit: number): string[] {
  return [...scores]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/** Most-used hashtags across notes, counted once per author per tag. */
export function trendingHashtags(
  notes: NostrEvent[],
  limit: number,
): { tag: string; count: number }[] {
  const authorsByTag = new Map<string, Set<string>>();
  for (const e of notes) {
    if (e.kind !== KIND_NOTE) continue;
    const tags = new Set([
      ...tagValues(e.tags, "t").map((t) => t.toLowerCase()),
      ...hashtagsOf(e.content),
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

/** Accounts followed by the most others, excluding `exclude`. */
export function mostFollowed(
  contactLists: NostrEvent[],
  exclude: Set<string>,
  limit: number,
): { pubkey: string; followers: number }[] {
  const latest = new Map<string, NostrEvent>();
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
    .sort(
      (a, b) => b.followers - a.followers || a.pubkey.localeCompare(b.pubkey),
    )
    .slice(0, limit);
}
