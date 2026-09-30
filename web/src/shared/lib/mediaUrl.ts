/**
 * Browser media URL handling.
 *
 * Desktop rewrites relay media URLs through its native media serving layer;
 * the browser loads media URLs (relay-hosted or external) directly, so this
 * is a passthrough kept interface-compatible with the desktop helper so
 * shared components (UserAvatar) port unmodified.
 */
export function rewriteRelayUrl(url: string): string {
  return url;
}
