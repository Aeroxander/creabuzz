/**
 * Upload size ceilings, mirroring the relay's media limits.
 *
 * Kept free of `@/` imports so it can be unit-tested under `node --test`.
 *
 * These are advisory: the relay is authoritative (see
 * `crates/buzz-media/src/config.rs` — image 50 MB, animated GIF 10 MB, video
 * 500 MB, other files 100 MB) and still enforces whatever a deployment
 * configures. Checking first matters because the upload path reads the whole
 * file into memory and hashes it before sending: without this, a file over the
 * limit costs the reader hundreds of megabytes of tab memory and a long read
 * before the relay refuses it.
 */

export const MEBIBYTE = 1024 * 1024;

export const UPLOAD_LIMITS = {
  gif: 10 * MEBIBYTE,
  image: 50 * MEBIBYTE,
  video: 500 * MEBIBYTE,
  file: 100 * MEBIBYTE,
} as const;

/** The ceiling that applies to a file of this media type. */
export function uploadLimitFor(type: string): number {
  const normalized = type.toLowerCase();
  if (normalized === "image/gif") return UPLOAD_LIMITS.gif;
  if (normalized.startsWith("image/")) return UPLOAD_LIMITS.image;
  if (normalized.startsWith("video/")) return UPLOAD_LIMITS.video;
  return UPLOAD_LIMITS.file;
}

function formatBytes(bytes: number): string {
  const mib = bytes / MEBIBYTE;
  return mib >= 1 ? `${Math.round(mib)} MB` : `${bytes} bytes`;
}

/**
 * Message explaining why this file cannot be uploaded, or `null` when it can.
 */
export function uploadSizeError(file: {
  size: number;
  type: string;
}): string | null {
  const limit = uploadLimitFor(file.type);
  if (file.size <= limit) return null;
  return `This file is ${formatBytes(file.size)}, over the ${formatBytes(limit)} limit for ${file.type || "this kind of file"}.`;
}
