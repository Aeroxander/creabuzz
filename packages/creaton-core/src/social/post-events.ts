/**
 * What the social client publishes, on standard Nostr so nostter, Damus,
 * Primal and 0xchat read it as ordinary posts:
 *
 * - A post is a kind 1 note: `t` tags for hashtags, `p` tags for the people it
 *   mentions (`nostr:npub…` in the text, NIP-27).
 * - A reply uses NIP-10 marked `e` tags (the feed's `buildReply`).
 * - A quote post is a kind 1 note with a `q` tag and a `nostr:nevent…` link in
 *   the text (NIP-18).
 * - A repost is kind 6 with empty content and an `e` tag naming the original
 *   (NIP-18); undoing one is a NIP-09 deletion.
 * - A vote is the NIP-25 reaction the feed builds (`feed-events.ts` `buildVote`).
 *
 * Pure and alias-free: `social.test.mjs` drives it under `node --test`.
 */

import { KIND_DELETION, KIND_REPOST } from "../kinds.ts";
import {
  buildPost,
  buildReply,
  type EventTemplate,
  MAX_POST_CHARS,
  type SignedEventLike,
} from "./feed/feed-events.ts";
import { mentionedPubkeys } from "./content.ts";
import { neventOf } from "./entity.ts";

/** Add a `p` tag for everyone the text mentions (NIP-27), keeping existing ones. */
export function withMentions(template: EventTemplate): EventTemplate {
  const have = new Set(
    template.tags.filter((t) => t[0] === "p").map((t) => t[1]),
  );
  const extra = mentionedPubkeys(template.content)
    .filter((pk) => !have.has(pk))
    .map((pk) => ["p", pk]);
  return { ...template, tags: [...template.tags, ...extra] };
}

/** A top-level post. */
export function buildSocialPost(text: string): EventTemplate {
  return withMentions(buildPost({ text }));
}

/** A reply; `root` is the thread's first note, `parent` the one answered. */
export function buildSocialReply(input: {
  text: string;
  root: SignedEventLike;
  parent: SignedEventLike;
}): EventTemplate {
  return withMentions(buildReply(input));
}

/** A quote post: the author's comment plus a reference to `quoted`. */
export function buildQuote(input: {
  text: string;
  quoted: SignedEventLike;
}): EventTemplate {
  const comment = input.text.trim();
  const ref = `nostr:${neventOf(input.quoted.id, input.quoted.pubkey)}`;
  if (comment === "") throw new Error("Write something first.");
  if ([...comment].length > MAX_POST_CHARS) {
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  }
  const post = buildPost({ text: comment });
  return withMentions({
    ...post,
    content: `${post.content}\n\n${ref}`,
    tags: [
      ...post.tags,
      ["q", input.quoted.id, "", input.quoted.pubkey],
      ["p", input.quoted.pubkey],
    ],
  });
}

/**
 * NIP-18 repost of a kind 1 note. The content is left empty on purpose: NIP-18 lets a repost carry a copy of the note, but a
 * copy would outlive the note's deletion and keep its words readable on the server for anyone who asks for reposts. This
 * app reads the original by its id (`timeline.ts`), so nothing is lost and a deleted post is gone everywhere here.
 */
export function buildRepost(
  note: Pick<SignedEventLike, "id" | "pubkey">,
): EventTemplate {
  return {
    kind: KIND_REPOST,
    tags: [
      ["e", note.id],
      ["p", note.pubkey],
    ],
    content: "",
  };
}

/** NIP-09 deletion of one of the viewer's own events (undo repost). */
export function buildUndo(eventId: string, kind: number): EventTemplate {
  return {
    kind: KIND_DELETION,
    tags: [
      ["e", eventId],
      ["k", String(kind)],
    ],
    content: "",
  };
}
