/**
 * The one rule for wiki page slugs.
 *
 * A page's slug and a `[[wikilink]]` written inside another page are the same
 * identity, so both must normalise identically; the dialog and the link
 * extractor each had their own copy and produced different results.
 *
 * Alias-free on purpose: `slug.test.mjs` drives it under `node --test`.
 */
export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
