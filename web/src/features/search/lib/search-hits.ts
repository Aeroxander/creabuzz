/**
 * What community search looks at, and where opening a hit goes.
 *
 * Board posts and their replies are searched with the room conversation: they are kept under their board's `h` tag like
 * a room's messages, so the room-scoped filter finds them once their kinds are asked for. Before, the kinds list named
 * only chat messages, so a word that was all over a board found nothing.
 *
 * Alias-free; `search-hits.test.mjs` drives it under `node --test`.
 */

import {
  KIND_AGENT_TASK,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_GIT_ISSUE,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  KIND_WIKI_PAGE,
} from "@creaton/core/kinds.ts";

/** Kinds searched under the community's rooms and boards. */
export const ROOM_SEARCH_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
  KIND_WIKI_PAGE,
  KIND_AGENT_TASK,
  KIND_GIT_ISSUE,
];

/** Kinds searched in the community as a whole (kept under no room). */
export const COMMUNITY_SEARCH_KINDS = [
  KIND_WIKI_PAGE,
  KIND_AGENT_TASK,
  KIND_GIT_ISSUE,
];

export interface HitTarget {
  /** What the hit is, when it is not shown by its room's name. */
  label: string;
  /** A page outside the rooms: the wiki, or the work board. */
  view?: "wiki" | "work";
  /** The wiki page's name. */
  id?: string;
  /** The board post to open: the post itself, or the one a reply is under. */
  post?: string;
}

function tag(tags: readonly (readonly string[])[], name: string) {
  return tags.find((t) => t[0] === name)?.[1];
}

/** The post a board reply is under: its `root` mark, else what it answers, else its first reference. */
function postOf(tags: readonly (readonly string[])[]): string | undefined {
  const refs = tags.filter((t) => t[0] === "e" && typeof t[1] === "string");
  return (
    refs.find((t) => t[3] === "root")?.[1] ??
    refs.find((t) => t[3] === "reply")?.[1] ??
    refs[0]?.[1]
  );
}

export function hitTarget(event: {
  id: string;
  kind: number;
  tags: readonly (readonly string[])[];
}): HitTarget {
  if (event.kind === KIND_WIKI_PAGE) {
    const slug = tag(event.tags, "d");
    // A wiki page has no channel: without this, its hit was unopenable.
    return slug
      ? { label: "wiki page", view: "wiki", id: slug }
      : { label: "wiki page" };
  }
  if (event.kind === KIND_AGENT_TASK || event.kind === KIND_GIT_ISSUE) {
    return {
      label: event.kind === KIND_GIT_ISSUE ? "issue" : "task",
      view: "work",
    };
  }
  if (event.kind === KIND_FORUM_POST) {
    return { label: "board post", post: event.id };
  }
  if (event.kind === KIND_FORUM_COMMENT) {
    const post = postOf(event.tags);
    return post ? { label: "reply", post } : { label: "reply" };
  }
  return { label: "message" };
}

/** A board post's words as a search hit shows them: the title line without its Markdown heading mark. */
export function hitText(event: { kind: number; content: unknown }): string {
  const text = typeof event.content === "string" ? event.content : "";
  return event.kind === KIND_FORUM_POST ? text.replace(/^#{1,6}\s+/, "") : text;
}

/**
 * A hit as two parts: a board post's title (its first line, without the heading mark) and the words after it, or no
 * title and all the words for anything else. A result shows the title on its own line above a short excerpt.
 */
export function hitParts(event: { kind: number; content: unknown }): {
  title: string | null;
  excerpt: string;
} {
  const text = hitText(event);
  if (event.kind !== KIND_FORUM_POST) return { title: null, excerpt: text };
  const [first = "", ...rest] = text.split("\n");
  const title = first.trim();
  const excerpt = rest.join("\n").trim();
  return title === "" ? { title: null, excerpt } : { title, excerpt };
}
