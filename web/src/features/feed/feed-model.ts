import type { NostrEvent } from "@/shared/lib/nostr-client";
import { verifyEvent } from "nostr-tools/pure";

export const KIND_PROFILE = 0;
export const KIND_NOTE = 1;
export const KIND_CONTACTS = 3;
export const KIND_REPOST = 6;
export const KIND_REACTION = 7;
export const KIND_DELETION = 5;
export const KIND_MUTES = 10000;
export const KIND_BOOKMARKS = 10003;

export interface Profile {
  pubkey: string;
  name?: string;
  displayName?: string;
  picture?: string;
  banner?: string;
  about?: string;
  website?: string;
  nip05?: string;
}

export interface PostMeta {
  replies: number;
  likes: number;
  reposts: number;
  likedByViewer: boolean;
  /** Id of the viewer's own repost event (so it can be undone), if any. */
  viewerRepostId: string | null;
}

export interface Post {
  event: NostrEvent;
  /** Event id this note replies to, if any (NIP-10 `reply` or last `e` marker). */
  parentId: string | null;
  /** Set when this row is a NIP-18 repost: who reposted it and when. */
  repostedBy?: { pubkey: string; at: number };
}

export const EMPTY_META: PostMeta = {
  replies: 0,
  likes: 0,
  reposts: 0,
  likedByViewer: false,
  viewerRepostId: null,
};

/** Time a post surfaced in a timeline: the repost time for reposts, else its own time. */
export function activityAt(post: Post): number {
  return post.repostedBy?.at ?? post.event.created_at;
}

/**
 * The reposted note embedded in a kind 6 `content`, if present and authentic
 * (valid signature and matches the `e` tag). Otherwise null — callers fetch it by id.
 */
export function embeddedRepostTarget(repost: NostrEvent): NostrEvent | null {
  const targetId = lastTagValue(repost.tags, "e");
  if (!repost.content || !targetId) return null;
  try {
    const parsed = JSON.parse(repost.content) as NostrEvent;
    return parsed.id === targetId && verifyEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parentIdOf(event: NostrEvent): string | null {
  const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
  if (eTags.length === 0) return null;
  const marked =
    eTags.find((t) => t[3] === "reply") ?? eTags.find((t) => t[3] === "root");
  return (marked ?? eTags[eTags.length - 1])[1] ?? null;
}

export function toPost(event: NostrEvent): Post {
  return { event, parentId: parentIdOf(event) };
}

export function parseProfile(event: NostrEvent): Profile {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(event.content);
    if (value && typeof value === "object") parsed = value;
  } catch {
    // Malformed profile JSON — fall back to the bare pubkey.
  }
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    pubkey: event.pubkey,
    name: str(parsed.name),
    displayName: str(parsed.display_name) ?? str(parsed.displayName),
    picture: str(parsed.picture),
    banner: str(parsed.banner),
    about: str(parsed.about),
    website: str(parsed.website),
    nip05: str(parsed.nip05),
  };
}

/** Newest-first, de-duplicated by event id. */
export function sortNewestFirst(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const unique = events.filter((e) => !seen.has(e.id) && seen.add(e.id));
  return unique.sort((a, b) => b.created_at - a.created_at);
}

export function computeMeta(
  ids: string[],
  related: NostrEvent[],
  viewer: string | null,
): Map<string, PostMeta> {
  const out = new Map<string, PostMeta>(
    ids.map((id) => [id, { ...EMPTY_META }]),
  );
  const seen = new Set<string>();
  for (const e of related) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    for (const t of e.tags) {
      if (t[0] !== "e" || !t[1]) continue;
      const meta = out.get(t[1]);
      if (!meta) continue;
      if (e.kind === KIND_REACTION && (e.content === "+" || e.content === "")) {
        meta.likes += 1;
        if (viewer && e.pubkey === viewer) meta.likedByViewer = true;
      } else if (e.kind === KIND_REPOST) {
        meta.reposts += 1;
        if (viewer && e.pubkey === viewer) meta.viewerRepostId = e.id;
      } else if (e.kind === KIND_NOTE && parentIdOf(e) === t[1]) {
        meta.replies += 1;
      }
    }
  }
  return out;
}

/** Values of every `name` tag (`p` pubkeys, `e` ids, …), de-duplicated in order. */
export function tagValues(tags: string[][], name: string): string[] {
  return [
    ...new Set(tags.filter((t) => t[0] === name && t[1]).map((t) => t[1])),
  ];
}

const HASHTAG = /(?:^|[\s(])#([\p{L}\p{N}_]+)/gu;
const NOSTR_URI = /nostr:((?:npub|nprofile)1[0-9a-z]+)/g;

/** NIP-24 `t` tags (lowercased) for every hashtag in `content`. */
export function hashtagsOf(content: string): string[] {
  return [
    ...new Set([...content.matchAll(HASHTAG)].map((m) => m[1].toLowerCase())),
  ];
}

/** Bech32 `npub`/`nprofile` mention bodies found as `nostr:` URIs in `content`. */
export function mentionEntitiesOf(content: string): string[] {
  return [...new Set([...content.matchAll(NOSTR_URI)].map((m) => m[1]))];
}

export function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(url);
}

/** Value of the last `name` tag (NIP-18 puts the reposted event last). */
export function lastTagValue(
  tags: string[][],
  name: string,
): string | undefined {
  const values = tagValues(tags, name);
  return values[values.length - 1];
}
