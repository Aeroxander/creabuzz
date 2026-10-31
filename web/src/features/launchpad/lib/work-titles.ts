/**
 * What a piece of work is called on screen. Work areas and submissions are keyed on the chain by a short name of up to
 * 32 characters, often typed code-style ("first-hour-notes"). People read a title instead ("First hour notes"), or the
 * words someone published for it (a suggestion's own title); the short name stays the key and is shown only beside it.
 *
 * Pure and alias-free: `work-titles.test.mjs` drives it under `node --test`.
 */

import { idLabel } from "@creaton/core/launchpad/work.ts";

/** A code-style short name: lower-case letters and digits joined by dashes or underscores. */
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** A short name as a title: "first-hour-notes" reads "First hour notes"; anything not code-style is left as typed. */
export function readableName(label: string): string {
  if (!SLUG.test(label)) return label;
  const spaced = label.replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The title for a work area or submission from its id on the chain: a title published for it (`known`, keyed by its
 * short name in lower case) when there is one, else its short name made readable.
 */
export function workTitle(
  id: string,
  known?: ReadonlyMap<string, string>,
): string {
  const label = idLabel(id);
  return known?.get(label.toLowerCase()) ?? readableName(label);
}

/** The short name to show beside a title, or null when the title already is the short name. */
export function shortNameBeside(id: string, title: string): string | null {
  const label = idLabel(id);
  return label === title || label.includes("…") ? null : label;
}

/**
 * Titles people published for work areas, keyed by short name: the title of the suggestion an area on the chain was
 * approved from. Only a suggestion whose short name and words match an approved area counts (`approved`: each area's
 * id and check hash), so a later suggestion reusing the short name with other words cannot rename it. When several
 * match, the earliest posted wins: a copy posted after the vote cannot either.
 */
export function knownTitles(
  suggestions: readonly {
    projectId: string;
    checkHash: string;
    title: string;
    createdAt: number;
  }[],
  approved: readonly { projectId: string; checkHash: string }[],
): Map<string, string> {
  const areas = new Set(
    approved.map(
      (a) => `${a.projectId.toLowerCase()}:${a.checkHash.toLowerCase()}`,
    ),
  );
  const out = new Map<string, { title: string; at: number }>();
  for (const s of suggestions) {
    const title = s.title.trim();
    if (title === "") continue;
    if (!areas.has(`${s.projectId.toLowerCase()}:${s.checkHash.toLowerCase()}`))
      continue;
    const key = idLabel(s.projectId).toLowerCase();
    const seen = out.get(key);
    if (!seen || s.createdAt < seen.at)
      out.set(key, { title, at: s.createdAt });
  }
  return new Map([...out].map(([key, { title }]) => [key, title]));
}

/** Text that quotes short names (“garden-guide”), with each made readable (“Garden guide”). Other quotes stay. */
export function readableQuotes(text: string): string {
  return text.replace(/“([^”]{1,32})”/g, (whole, inner: string) =>
    SLUG.test(inner) ? `“${readableName(inner)}”` : whole,
  );
}
