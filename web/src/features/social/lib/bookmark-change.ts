/**
 * Saving a post is one edit of the reader's bookmark list (kind 10003). The note ids sit privately in the list's
 * `content` (sealed with the reader's own key), beside the public tags the launch follows use. Pure and alias-free:
 * `bookmark-change.test.mjs` drives it under `node --test`.
 */

import type {
  EventTemplate,
  SignedEventLike,
} from "../../feed/lib/feed-events.ts";
import { tagValues } from "./engagement.ts";
import { bookmarkedIds, parsePrivateTags, withBookmark } from "./lists.ts";

/** Opens the list's private part with the reader's key. */
export type OpenPrivate = (ciphertext: string) => Promise<string>;
/** Seals the list's private part with the reader's key. */
export type SealPrivate = (plaintext: string) => Promise<string>;

/** Said when the list was written in a form this app cannot open: it is shown, never overwritten. */
export const UNREADABLE_BOOKMARKS =
  "Your saved posts were written by another app in a form this one can't read, so nothing was changed.";

/** The private entries of `list`, or null when its content cannot be opened. */
async function privateTagsOf(
  list: SignedEventLike | null,
  open: OpenPrivate,
): Promise<string[][] | null> {
  if (!list?.content) return [];
  try {
    return parsePrivateTags(await open(list.content));
  } catch {
    return null;
  }
}

/** Ids of the saved posts: the public tags plus whatever of the private part can be opened. */
export async function savedIds(
  list: SignedEventLike | null,
  open: OpenPrivate,
): Promise<string[]> {
  return bookmarkedIds(list, (await privateTagsOf(list, open)) ?? []);
}

/**
 * The bookmark list after saving (`saved`) or removing one post, from the newest list, with the ids it then holds.
 * Throws, so nothing is written, when the list's private part cannot be opened: writing over it would lose it.
 */
export async function bookmarkChange(
  latest: SignedEventLike | null,
  id: string,
  saved: boolean,
  { open, seal }: { open: OpenPrivate; seal: SealPrivate },
): Promise<{ template: EventTemplate; ids: string[] }> {
  const opened = await privateTagsOf(latest, open);
  if (opened === null) throw new Error(UNREADABLE_BOOKMARKS);
  const next = withBookmark(latest, opened, id, saved);
  const content = next.privateTags.length
    ? await seal(JSON.stringify(next.privateTags))
    : "";
  return {
    template: {
      kind: next.kind,
      tags: next.tags,
      content,
      created_at: next.created_at,
    },
    ids: tagValues([...next.tags, ...next.privateTags], "e"),
  };
}
