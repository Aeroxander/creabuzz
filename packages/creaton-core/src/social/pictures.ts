/**
 * Pictures in posts, as plain data: what a picture may be before it is sent, and how it is described in the post (NIP-92
 * `imeta` tags, which other apps read the same way). The picture's bytes are cleaned in `picture-bytes.ts`. Pure and
 * alias-free: `pictures.test.mjs` drives it under `node --test`.
 */

import type { EventTemplate } from "./feed/feed-events.ts";
import { MAX_POST_CHARS } from "./feed/feed-events.ts";

/** Pictures in one post. */
export const MAX_PICTURES = 4;
/** The largest picture file taken in (a phone photo is a few megabytes); it is shrunk before it is sent. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** The largest a picture may be once it has been shrunk, which is what is sent. */
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
/** The longest side, in pixels, of a picture as sent. */
export const MAX_PICTURE_EDGE = 2048;
/** The longest description of a picture. */
export const MAX_ALT_CHARS = 300;

/** Kinds of picture a person may pick. Whatever is picked is re-drawn, so what is sent is always a JPEG or a PNG. */
const PICTURE_SOURCE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

/** Why this file cannot be added as a picture, or null when it can. */
export function sourcePictureProblem(file: {
  size: number;
  type: string;
}): string | null {
  if (
    !(PICTURE_SOURCE_TYPES as readonly string[]).includes(
      file.type.toLowerCase(),
    )
  )
    return "That file is not a picture this app can use. Choose a JPEG, PNG, WebP or GIF picture.";
  if (file.size > MAX_SOURCE_BYTES)
    return `That picture is ${Math.ceil(file.size / (1024 * 1024))} MB. Choose one under ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.`;
  return null;
}

/** A picture in a post: where it is kept and what it shows, in words. */
export interface PostPicture {
  url: string;
  /** What the picture shows, for people who cannot see it. */
  alt: string;
  mime?: string;
  sha256?: string;
  width?: number;
  height?: number;
}

/** A description as it is kept: one line, trimmed, no longer than {@link MAX_ALT_CHARS}. */
export function cleanAlt(alt: string): string {
  return [...alt.replace(/\s+/g, " ").trim()].slice(0, MAX_ALT_CHARS).join("");
}

/** The `imeta` tags that describe `pictures` (NIP-92), one per picture. */
export function pictureTags(pictures: readonly PostPicture[]): string[][] {
  return pictures.map((p) => {
    const tag = ["imeta", `url ${p.url}`];
    if (p.mime) tag.push(`m ${p.mime}`);
    const alt = cleanAlt(p.alt);
    if (alt) tag.push(`alt ${alt}`);
    if (p.sha256) tag.push(`x ${p.sha256}`);
    if (p.width && p.height) tag.push(`dim ${p.width}x${p.height}`);
    return tag;
  });
}

const BARE_URL_LINE = /^https?:\/\/\S+$/;
const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i;

/**
 * The pictures a post shows. `keep` says which addresses may be drawn (the app draws only those on this community's own
 * server, so reading a post never asks another website for anything): the ones its `imeta` tags describe, and a bare
 * picture address on a line of its own, which is how this server's earlier web app wrote them (with no description).
 */
export function picturesOf(
  event: { content: string; tags: readonly string[][] },
  keep: (url: string) => boolean,
): PostPicture[] {
  const found = new Map<string, PostPicture>();
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    const fields = new Map<string, string>();
    for (const field of tag.slice(1)) {
      const space = field.indexOf(" ");
      if (space > 0) fields.set(field.slice(0, space), field.slice(space + 1));
    }
    const url = fields.get("url");
    if (!url || !keep(url) || found.has(url)) continue;
    found.set(url, { url, alt: cleanAlt(fields.get("alt") ?? "") });
  }
  for (const line of event.content.split("\n")) {
    const url = line.trim();
    if (
      BARE_URL_LINE.test(url) &&
      IMAGE_URL.test(url) &&
      keep(url) &&
      !found.has(url)
    )
      found.set(url, { url, alt: "" });
  }
  return [...found.values()].slice(0, MAX_PICTURES);
}

/** The text of a post without the addresses of its pictures, and without the blank lines they leave behind. */
export function textWithoutPictures(
  content: string,
  pictures: readonly { url: string }[],
): string {
  if (pictures.length === 0) return content;
  const urls = new Set(pictures.map((p) => p.url));
  return content
    .split("\n")
    .filter((line) => !urls.has(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `template` with its `pictures`: their addresses after the words (so apps that do not read `imeta` still show a link) and
 * their descriptions in `imeta` tags. Refuses more than {@link MAX_PICTURES} and a post longer than a post may be.
 */
export function withPictures(
  template: EventTemplate,
  pictures: readonly PostPicture[],
): EventTemplate {
  if (pictures.length === 0) return template;
  if (pictures.length > MAX_PICTURES)
    throw new Error(`A post can have up to ${MAX_PICTURES} pictures.`);
  const content = [template.content, ...pictures.map((p) => p.url)]
    .filter((part) => part !== "")
    .join("\n");
  if ([...content].length > MAX_POST_CHARS)
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  return {
    ...template,
    content,
    tags: [...template.tags, ...pictureTags(pictures)],
  };
}
