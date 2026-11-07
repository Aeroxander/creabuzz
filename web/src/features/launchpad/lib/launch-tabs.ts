/**
 * Which tabs a project page shows, where a link to a tab it does not show goes, and which settings its founder gets.
 *
 * Three kinds of page share one component: an idea (no money and no DAO yet), a contributor project (a DAO from day
 * one, Shares only earned for work) and a raise. A contributor-only build (`raisesOffered()` false, the hosted pilot)
 * shows an idea without the older team surfaces (helpers and the community task board), and gives its founder the same
 * small settings a contributor project has instead of a sale checklist that build can never open.
 *
 * Pure and alias-free: `launch-tabs.test.mjs` drives it under `node --test`.
 */

export type LaunchTab =
  | "overview"
  | "milestones"
  | "discussion"
  | "updates"
  | "proposals"
  | "treasury"
  | "mybids"
  | "decisions"
  | "work"
  | "contributions"
  | "record"
  | "agents"
  | "manage";

export type PageKind = "idea" | "contributor" | "raise";

/** The tabs a contributor project shows: its work, its votes, who earned what, the talk around it, its funds and settings. */
const CONTRIBUTOR_TABS: ReadonlySet<LaunchTab> = new Set([
  "overview",
  "contributions",
  "decisions",
  "work",
  "discussion",
  "updates",
  "treasury",
  "manage",
]);

/** An idea has no money, decisions or treasury yet: showing those tabs empty makes the page look broken, not early. */
const IDEA_TABS: ReadonlySet<LaunchTab> = new Set([
  "overview",
  "agents",
  "discussion",
  "updates",
  "manage",
]);

/** The same without the helpers tab, which a contributor-only build has nothing behind. */
const IDEA_TABS_WITHOUT_RAISES: ReadonlySet<LaunchTab> = new Set([
  "overview",
  "discussion",
  "updates",
  "manage",
]);

/** The tabs this kind of page may show, or null for "every tab the page has" (a raise). */
export function allowedTabs(
  kind: PageKind,
  raises: boolean,
): ReadonlySet<LaunchTab> | null {
  if (kind === "contributor") return CONTRIBUTOR_TABS;
  if (kind === "idea") return raises ? IDEA_TABS : IDEA_TABS_WITHOUT_RAISES;
  return null;
}

/**
 * Where a link to a tab goes. The recorded proposals of old are gone: a link to them opens the decisions, which are
 * read from the network. A contributor project's track record is who earned what; its helpers live on the overview.
 */
export function tabAlias(tab: LaunchTab, kind: PageKind): LaunchTab {
  if (tab === "proposals") return "decisions";
  if (kind === "contributor") {
    if (tab === "record") return "contributions";
    if (tab === "agents") return "overview";
  }
  return tab;
}

/**
 * The founder's settings: a contributor project, and an idea in a build without raises, get the small edit-or-remove
 * panel; everything else gets the sale's own manage panel.
 */
export function founderSettings(
  kind: PageKind,
  raises: boolean,
): "settings" | "sale" {
  if (kind === "contributor") return "settings";
  if (kind === "idea" && !raises) return "settings";
  return "sale";
}

/** Whether an idea's overview lists the older team surfaces (community work board, helpers). */
export function ideaShowsTeamSurfaces(raises: boolean): boolean {
  return raises;
}
