/**
 * Words for a link in someone's evidence: a post on this site's boards reads "Post on a board" instead of its long
 * address. Any other link is shown as written: it was put there by someone else, so people should see where it goes.
 *
 * Pure and alias-free: `link-label.test.mjs` drives it under `node --test`.
 */

export function linkLabel(href: string, origin: string): string {
  try {
    const url = new URL(href);
    if (url.origin !== new URL(origin).origin) return href;
    if (/^\/b\/[^/]+\/?$/.test(url.pathname))
      return url.searchParams.has("post") ? "Post on a board" : "A board";
  } catch {}
  return href;
}
