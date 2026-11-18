/**
 * A failed upload in plain words. The server's media service answers a refused upload with a short code in its JSON
 * `error` (`buzz-media` `MediaError`, shown by `upload-blob.ts` as the thrown message); the ones a person can act on
 * are said here, with what to do next. Anything else goes through `failureWords` with the caller's fallback.
 *
 * Alias-free: `media-refusal.test.mjs` drives it under `node --test`.
 */
import {
  errorMessage,
  type FailureWords,
  failureWords,
} from "./readable-error.ts";

/** Someone the server will not take uploads from: not on an invite-only server's list, or banned. */
export const UPLOAD_NOT_ALLOWED_TEXT =
  "You can't upload to this community. If it's invite-only, open the invite link you were sent.";
/** The per-minute upload limit. */
export const UPLOAD_TOO_FAST_TEXT =
  "You're uploading a bit fast. Wait a minute, then try again.";
/** Too many uploads from this person at once. */
export const UPLOAD_TOO_MANY_TEXT =
  "Other uploads of yours are still going. Wait for them to finish, then try again.";
/** The media service could not check or store it just now. */
export const UPLOAD_UNAVAILABLE_TEXT =
  "Uploads aren't working on this server just now. Try again in a minute.";
/** The community is not taking changes (it is being moved or closed). */
export const UPLOAD_PAUSED_TEXT =
  "This community isn't taking uploads right now. Try again later.";
/** A file the server could not read as a picture. */
export const UPLOAD_NOT_A_PICTURE_TEXT =
  "The server couldn't read that file as a picture. Try another one.";
/** A kind of file the server does not take. */
export const UPLOAD_WRONG_KIND_TEXT =
  "The server doesn't take this kind of file. Try another one.";
/** Over the server's own size limit (which can be lower than the app's own check). */
export const UPLOAD_TOO_BIG_TEXT =
  "This file is too big for this server. Try a smaller one.";

/**
 * The media service's refusals (the `#[error(...)]` words in `crates/buzz-media/src/error.rs`), each said plainly. The
 * server's wording is the contract: `media-refusal.test.mjs` reads it from the source. A ban is refused with the same
 * words as someone not on the list (`api/media.rs` `membership_denial`), so one sentence covers both.
 */
const MEDIA_REFUSALS: [RegExp, string][] = [
  [/^relay membership required$/, UPLOAD_NOT_ALLOWED_TEXT],
  [/^upload rate limit exceeded$/, UPLOAD_TOO_FAST_TEXT],
  [/^upload concurrency limit reached$/, UPLOAD_TOO_MANY_TEXT],
  [/^media service temporarily unavailable$/, UPLOAD_UNAVAILABLE_TEXT],
  [/^community writes are fenced$/, UPLOAD_PAUSED_TEXT],
  [/^invalid image data$/, UPLOAD_NOT_A_PICTURE_TEXT],
  [
    /^(unknown content type|disallowed content type: .*)$/,
    UPLOAD_WRONG_KIND_TEXT,
  ],
  // `upload failed (413)`: a body over the server's own limit, refused before the media service read it.
  [
    /^(file too large(: .*)?|image dimensions too large|upload failed \(413\))$/,
    UPLOAD_TOO_BIG_TEXT,
  ],
];

/** The media service's refusal in plain words, or null when `message` is not one of them. */
export function mediaRefusalText(message: string): string | null {
  const trimmed = message.trim();
  for (const [pattern, words] of MEDIA_REFUSALS)
    if (pattern.test(trimmed)) return words;
  return null;
}

/**
 * A failed upload for main copy, with the raw words kept for Technical details: a media refusal in plain words, a
 * sentence the app wrote (a file over the size limit) as it is, anything else as `fallback`.
 */
export function uploadFailureWords(
  error: unknown,
  fallback: string,
): FailureWords {
  const words = failureWords(error, fallback);
  const raw = errorMessage(error);
  const media = mediaRefusalText(raw);
  return media === null ? words : { text: media, detail: raw.trim() };
}
