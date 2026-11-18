/**
 * Posts from many boards as one list (each post knows its board), and what a list shows of a post: the first lines of
 * its text, its first picture and its first link, and the time windows Top can be narrowed to. Home's timeline mixes
 * these posts with the short posts (`social/lib/mixed-timeline.ts`).
 *
 * Alias-free; `board-feed.test.mjs` drives it under `node --test`.
 */

import { KIND_FORUM_POST } from "./board-events.ts";
import { type BoardEvent, type BoardPost, buildBoard } from "./board-model.ts";

export interface FeedPost extends BoardPost {
  /** The board (channel id, the post's `h` tag) the post is on. */
  boardId: string;
}

/**
 * Posts from any number of boards, with their votes and replies, as one list.
 * Only posts on a board in `boards` are kept: a post whose board the reader
 * cannot see named (or that is not a board at all) has nowhere to open.
 */
export function buildFeed(
  events: readonly BoardEvent[],
  me: string | null,
  boards: ReadonlySet<string>,
): FeedPost[] {
  const boardOfPost = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== KIND_FORUM_POST) continue;
    const h = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (typeof h === "string" && boards.has(h)) boardOfPost.set(event.id, h);
  }
  return buildBoard(events, me)
    .posts.filter((post) => boardOfPost.has(post.id))
    .map((post) => ({ ...post, boardId: boardOfPost.get(post.id) ?? "" }));
}

/** The first words of a body as plain text, for a preview under the title. */
export function previewText(body: string, max = 220): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type FeedPeriod = "day" | "week" | "month" | "all";

export const FEED_PERIOD_LABELS: Record<FeedPeriod, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
  all: "All time",
};

const PERIOD_SECONDS: Record<Exclude<FeedPeriod, "all">, number> = {
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 30 * 24 * 3600,
};

/** The posts made within the period before `now` (Top's time window). */
export function withinPeriod<T extends { createdAt: number }>(
  posts: readonly T[],
  period: FeedPeriod,
  now: number,
): T[] {
  if (period === "all") return [...posts];
  const from = now - PERIOD_SECONDS[period];
  return posts.filter((post) => post.createdAt >= from);
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif)(?:[?#]\S*)?$/i;

/** Only web addresses: anything else in a post (`javascript:`, `data:`) is never shown as a picture or a link. */
function webUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export interface PostMedia {
  /** The first picture in the post: a Markdown image, or a bare address of an image file. */
  image: string | null;
  /** The first other link, with the site it goes to, for a "link post". */
  link: { url: string; host: string } | null;
}

/** What a list shows beside a post's title: its first picture and its first link. */
export function postMedia(body: string): PostMedia {
  let image: string | null = null;
  let link: PostMedia["link"] = null;
  const images = [...body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)];
  for (const match of images) {
    const url = webUrl(match[1]);
    if (url) {
      image = url.href;
      break;
    }
  }
  // Links: Markdown links that are not images, then bare addresses.
  const withoutImages = body.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const candidates = [
    ...[...withoutImages.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map(
      (m) => m[1],
    ),
    ...[...withoutImages.matchAll(/(?:^|\s)(https?:\/\/[^\s<>()]+)/g)].map(
      (m) => m[1],
    ),
  ];
  for (const raw of candidates) {
    const url = webUrl(raw);
    if (!url) continue;
    if (IMAGE_FILE.test(url.pathname)) {
      image ??= url.href;
      continue;
    }
    link ??= { url: url.href, host: url.hostname.replace(/^www\./, "") };
  }
  return { image, link };
}
