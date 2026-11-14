/**
 * Browser media URL handling.
 *
 * Desktop rewrites relay media URLs through its native media serving layer;
 * the browser loads external media URLs directly, so `rewriteRelayUrl` is a
 * passthrough kept interface-compatible with the desktop helper so shared
 * components port unmodified.
 *
 * Pictures on the community server's own media path are different: the
 * server answers every read of them only with a signed `Authorization`
 * header, which a plain `<img src>` cannot send. `serverMediaUrl` picks those
 * out so `server-media.ts` can fetch them with a token instead.
 */
export function rewriteRelayUrl(url: string): string {
  return url;
}

/**
 * `/media/<sha256>`, optionally with an extension or the `.thumb.jpg` variant:
 * the same shapes the server's media route accepts.
 */
const SERVER_MEDIA_PATH =
  /^\/media\/[0-9a-f]{64}(?:\.thumb\.jpg|\.[a-z0-9]{1,8})?$/;

/**
 * The address to fetch with a signed read when `url` is a picture on the
 * community server's own media path (`serverOrigin`, e.g. the app's own
 * `https://host`), else null. Other hosts — and anything that is not a web
 * address — keep loading as they always did, and never see the token.
 */
export function serverMediaUrl(
  url: string | null | undefined,
  serverOrigin: string,
): string | null {
  if (!url) return null;
  let parsed: URL;
  let origin: string;
  try {
    parsed = new URL(url);
    origin = new URL(serverOrigin).origin;
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.origin !== origin) return null;
  if (parsed.username || parsed.password) return null;
  if (!SERVER_MEDIA_PATH.test(parsed.pathname)) return null;
  // The query and fragment never reach the server's blob lookup; dropping
  // them keeps one cache entry per picture.
  return `${parsed.origin}${parsed.pathname}`;
}
