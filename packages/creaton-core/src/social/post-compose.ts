/**
 * A post as the writing box makes it and as the reading screens take it apart: words, pictures, an optional post being
 * quoted and an optional project it is about. One builder for a new post, a quote and an edited post (an edit is the same
 * parts again, with the words changed), so none of them can leave out a part the others keep.
 *
 * Pure and alias-free: `post-compose.test.mjs` drives it under `node --test`.
 */

import { parseEntity, neventOf } from "./entity.ts";
import {
  buildPost,
  displayText,
  type EventTemplate,
  type LaunchRef,
  MAX_POST_CHARS,
  parseLaunchCoordinate,
} from "./feed/feed-events.ts";
import { withMentions } from "./post-events.ts";
import {
  type PostPicture,
  picturesOf,
  textWithoutPictures,
  withPictures,
} from "./pictures.ts";

/** A post being quoted. */
export interface QuoteRef {
  id: string;
  pubkey: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A post: `text`, then its `pictures`, then the project it is about (`launch`), then the quoted post. A post may be only
 * pictures, but a quote needs words of its own (a plain repost is a different press). Throws the words a person is shown.
 */
export function buildComposedPost(input: {
  text: string;
  pictures?: readonly PostPicture[];
  launch?: LaunchRef | null;
  quote?: QuoteRef | null;
}): EventTemplate {
  const pictures = input.pictures ?? [];
  const words = input.text.trim();
  if (input.quote && words === "") throw new Error("Write something first.");
  if (!words && pictures.length === 0)
    throw new Error("Write something first.");
  if ([...words].length > MAX_POST_CHARS)
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  // The pictures' addresses are added after the project's reference, so `buildPost` sees only the words and can add
  // the topics and the reference; `withPictures` then adds the addresses and checks the whole length.
  const base = words
    ? buildPost({ text: words, launch: input.launch ?? null })
    : { kind: 1, tags: [] as string[][], content: "" };
  let template: EventTemplate = base;
  if (input.quote) {
    template = {
      ...template,
      content: `${template.content}\n\nnostr:${neventOf(input.quote.id, input.quote.pubkey)}`,
      tags: [
        ...template.tags,
        ["q", input.quote.id, "", input.quote.pubkey],
        ["p", input.quote.pubkey],
      ],
    };
  }
  template = withMentions(template);
  if (pictures.length > 0) return withPictures(template, pictures);
  if ([...template.content].length > MAX_POST_CHARS)
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  return template;
}

/** What a post is made of, for showing it and for editing it. */
export interface PostParts {
  /** The words as written, without the machine references and the pictures' addresses. */
  text: string;
  pictures: PostPicture[];
  /** The post this one quotes, from its `q` tag. */
  quote: QuoteRef | null;
  /** The project this post is about, when it names one. */
  launch: LaunchRef | null;
}

/** Take a post apart. `keepPicture` says which picture addresses may be drawn (see `picturesOf`). */
export function postParts(
  event: { content: string; tags: readonly string[][] },
  keepPicture: (url: string) => boolean,
): PostParts {
  const pictures = picturesOf(event, keepPicture);
  const qTag = event.tags.find((t) => t[0] === "q" && HEX64.test(t[1] ?? ""));
  const quote = qTag
    ? { id: qTag[1], pubkey: HEX64.test(qTag[3] ?? "") ? qTag[3] : "" }
    : null;
  let text = displayText(textWithoutPictures(event.content, pictures));
  if (quote)
    text = text
      .replace(/\n*nostr:(?:nevent|note)1[0-9a-z]+/g, (found) => {
        const entity = parseEntity(found.trim());
        return entity?.type === "event" && entity.id === quote.id ? "" : found;
      })
      .trim();
  const launchTag = event.tags.find(
    (t) => t[0] === "a" && parseLaunchCoordinate(t[1] ?? "") !== null,
  );
  return {
    text,
    pictures,
    quote: quote?.pubkey ? quote : null,
    launch: launchTag ? parseLaunchCoordinate(launchTag[1]) : null,
  };
}
