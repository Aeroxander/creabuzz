/**
 * The wiki's slug rules, in one place.
 *
 * Two addressing schemes meet here (docs/agent-wiki.md):
 *
 * - kind:44001 (human wiki) uses a bare `<slug>` in its `d` tag. A slug and a
 *   `[[wikilink]]` written inside another page are the same identity, so both
 *   must normalise identically.
 * - kind:44002 (agent wiki) uses `<space>/<slug>` in its `d` tag with a strict
 *   segment grammar; the relay envelope validation keeps malformed values from
 *   winning read-side LWW, and the read side defends in depth by rejecting a
 *   `d` that does not parse instead of rendering it.
 *
 * Alias-free on purpose: `slug.test.mjs` drives it under `node --test`.
 */

/** Cap on a kind:44002 `d` tag, in bytes (docs/agent-wiki.md). Segments are
 * ASCII-only by the grammar below, so byte length equals character length. */
export const AGENT_WIKI_D_MAX_LENGTH = 256;

/** Every `/`-separated segment of a kind:44002 `d` tag matches this. */
const AGENT_WIKI_SEGMENT = /^[a-z0-9][a-z0-9_.-]*$/;

/** Normalise a page name (or `[[wikilink]]` target) to a kind:44001 slug. */
export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Parse a kind:44002 `d` tag into its space and slug halves.
 *
 * Both halves must be non-empty and every `/`-separated segment must match
 * `[a-z0-9][a-z0-9_.-]*`; the slug may itself contain slashes (nested pages,
 * e.g. `default/projects/research/standup`). Returns null for anything the
 * grammar rejects — a malformed `d` is not a page this reader should show.
 */
export function parseSpaceSlug(
  d: string,
): { space: string; slug: string } | null {
  if (d.length === 0 || d.length > AGENT_WIKI_D_MAX_LENGTH) return null;
  const segments = d.split("/");
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!AGENT_WIKI_SEGMENT.test(segment)) return null;
  }
  return { space: segments[0], slug: segments.slice(1).join("/") };
}
