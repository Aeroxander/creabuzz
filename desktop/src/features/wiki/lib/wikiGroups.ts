/**
 * Wiki page grouping — which list a page belongs to.
 *
 * Corrections (`d: correction-for-<slug>`, kind:44003 and the legacy kind:44001
 * pages in the wild) are their own product surface: a correction proposes a
 * change to a team page and is reviewed/deleted per author. They must never
 * list as ordinary team pages. Everything else on the human wiki is a team
 * page; agent standups (kind:44002) stay their own group.
 *
 * Alias-free and pure so `wikiGroups.test.mjs` can drive it under `node --test`.
 */
import type { WikiPage } from "./pageIndex";

/** The `d`-tag prefix that marks a correction page (same on both kinds). */
export const CORRECTION_SLUG_PREFIX = "correction-for-";

export type WikiPageGroup = "team" | "corrections" | "agent";

/** One label owner for the page-list group headings. */
export const WIKI_GROUP_LABELS: Record<WikiPageGroup, string> = {
  team: "Wiki pages",
  corrections: "Corrections",
  agent: "Agent standups",
};

/** Classify one page into its product group. */
export function wikiPageGroup(
  page: Pick<WikiPage, "kind" | "key">,
): WikiPageGroup {
  if (page.kind === "agent") return "agent";
  return page.key.startsWith(CORRECTION_SLUG_PREFIX) ? "corrections" : "team";
}

/** Split a page set into the three groups (each keeps the input order). */
export function groupWikiPages(
  pages: readonly WikiPage[],
): Record<WikiPageGroup, WikiPage[]> {
  const groups: Record<WikiPageGroup, WikiPage[]> = {
    team: [],
    corrections: [],
    agent: [],
  };
  for (const page of pages) {
    groups[wikiPageGroup(page)].push(page);
  }
  return groups;
}
