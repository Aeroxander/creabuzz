/**
 * A founder's post as the writing box makes it: words, and the project it is about. Pure and alias-free:
 * `post-compose.test.mjs` drives it under `node --test`.
 */

import {
  buildPost,
  type EventTemplate,
  type LaunchRef,
  MAX_POST_CHARS,
} from "./feed/feed-events.ts";

/** A post: `text`, then the project it is about (`launch`). Throws the words a person is shown. */
export function buildComposedPost(input: {
  text: string;
  launch?: LaunchRef | null;
}): EventTemplate {
  const words = input.text.trim();
  if (!words) throw new Error("Write something first.");
  if ([...words].length > MAX_POST_CHARS)
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  const template = buildPost({ text: words, launch: input.launch ?? null });
  if ([...template.content].length > MAX_POST_CHARS)
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  return template;
}
