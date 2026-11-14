/**
 * What a profile picture may be: a picture file small enough to send, or a link to one on the web. Checked before
 * anything is read or uploaded, so a wrong file is turned away in words instead of failing at the server.
 *
 * Alias-free and import-free: `picture-check.test.mjs` drives it under `node --test`.
 */

/** The kinds of picture every browser shows. */
export const PICTURE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Big enough for any phone photo, small enough to load quickly beside every post. */
export const PICTURE_MAX_BYTES = 10 * 1024 * 1024;

/** Why this file cannot be a profile picture, or null when it can. */
export function pictureFileProblem(file: {
  size: number;
  type: string;
}): string | null {
  if (!(PICTURE_TYPES as readonly string[]).includes(file.type.toLowerCase())) {
    return "That file isn't a picture this app can use. Choose a PNG, JPEG, GIF or WebP image.";
  }
  if (file.size > PICTURE_MAX_BYTES) {
    const mb = Math.ceil(file.size / (1024 * 1024));
    return `That picture is ${mb} MB. Choose one under 10 MB.`;
  }
  return null;
}

/**
 * Why this pasted link cannot be a profile picture, or null when it can. An empty link removes the picture, and the
 * link the profile already has (`saved`) is never refused: a picture set in another app keeps working here.
 */
export function pictureLinkProblem(
  link: string,
  saved?: string | null,
): string | null {
  const trimmed = link.trim();
  if (!trimmed || trimmed === saved?.trim()) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That isn't a web address. Paste a link that starts with https://.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "That isn't a web address. Paste a link that starts with https://.";
  }
  return null;
}
