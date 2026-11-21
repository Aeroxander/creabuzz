/**
 * What a search looks for and how it picks. Pure.
 *
 * The server's word index covers people (their profiles), and may or may not cover posts (a fresh server does not), so posts
 * are found two ways at once: by asking the server's search, and by looking through the newest posts the app can read.
 * Projects are looked through in the list Home reads. Nothing found here is shown unless the reader would see it anywhere
 * else: the screen takes the result through `visiblePosts`.
 */
import { extractTopics } from "@creaton/core/social/feed/feed-events.ts";
import type { ProfileMetadata } from "@creaton/core/social/profiles/index-profiles.ts";
import type { Project } from "../project/project-record";

/** Fewest letters a search needs before it asks anyone. */
const MIN_QUERY = 2;
/** The most words a search uses (the rest are left off). */
export const MAX_WORDS = 6;
/** The most of each kind a search shows. */
export const MAX_PEOPLE = 8;
const MAX_PROJECTS = 6;
export const MAX_POSTS = 40;
/** The newest posts looked through for a word, and for the topics people use. */
export const SCAN_LIMIT = 500;

/** The words of a search, lower-case, at most {@link MAX_WORDS}. Empty when there is nothing to look for. */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

/** Whether a search is long enough to ask for. */
export function searchable(query: string): boolean {
  return query.trim().length >= MIN_QUERY;
}

/** The topic a search names when it starts with `#` (one word, as a topic is), or null. */
export function topicOfQuery(query: string): string | null {
  const match = /^\s*#([\p{L}\p{N}_-]{2,32})\s*$/u.exec(query);
  return match ? match[1].toLowerCase() : null;
}

/** Whether every word is somewhere in `text`. */
export function hasAllWords(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.length > 0 && words.every((word) => lower.includes(word));
}

interface Dated {
  id: string;
  created_at: number;
}

/** Newest first, ties by id so the order never flickers. */
function newestFirst<T extends Dated>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
  );
}

/** The posts that hold every word, from what was looked through and what the server's search returned, once each. */
export function postHits<T extends Dated & { content: string }>(
  looked: readonly T[],
  fromServer: readonly T[],
  words: readonly string[],
): T[] {
  const seen = new Set<string>();
  const hits: T[] = [];
  for (const post of [...looked, ...fromServer]) {
    // The server's index may match a word's other forms; what is shown holds the words typed.
    if (seen.has(post.id) || !hasAllWords(post.content, words)) continue;
    seen.add(post.id);
    hits.push(post);
  }
  return newestFirst(hits).slice(0, MAX_POSTS);
}

/** The projects whose name or line holds every word, newest activity first as given. */
export function projectHits(
  projects: readonly Project[],
  words: readonly string[],
): Project[] {
  return projects
    .filter((project) => hasAllWords(`${project.name} ${project.pitch}`, words))
    .slice(0, MAX_PROJECTS);
}

/** The people whose name or line holds every word, as the server returned them, without anyone in `hidden`. */
export function personHits(
  found: Readonly<Record<string, ProfileMetadata>>,
  words: readonly string[],
  hidden: ReadonlySet<string>,
): string[] {
  return Object.entries(found)
    .filter(
      ([pubkey, profile]) =>
        !hidden.has(pubkey.toLowerCase()) &&
        hasAllWords(
          `${profile.name ?? ""} ${profile.display_name ?? ""} ${profile.about ?? ""} ${profile.nip05 ?? ""}`,
          words,
        ),
    )
    .map(([pubkey]) => pubkey)
    .slice(0, MAX_PEOPLE);
}

/**
 * The topics people are using now: each counted once per person, most people first, from posts the reader is shown. A
 * topic made only of a holder room's tag never shows (`extractTopics` cannot make one).
 */
export function topTopics(
  posts: readonly {
    pubkey: string;
    content: string;
    tags: readonly string[][];
  }[],
  limit: number,
): { tag: string; people: number }[] {
  const people = new Map<string, Set<string>>();
  for (const post of posts) {
    const tags = new Set([
      ...post.tags
        .filter((t) => t[0] === "t" && typeof t[1] === "string")
        .map((t) => (t[1] as string).toLowerCase())
        .filter((t) => !t.includes(":")),
      ...extractTopics(post.content),
    ]);
    for (const tag of tags) {
      const set = people.get(tag) ?? new Set<string>();
      set.add(post.pubkey);
      people.set(tag, set);
    }
  }
  return [...people]
    .map(([tag, set]) => ({ tag, people: set.size }))
    .sort((a, b) => b.people - a.people || (a.tag < b.tag ? -1 : 1))
    .slice(0, limit);
}
