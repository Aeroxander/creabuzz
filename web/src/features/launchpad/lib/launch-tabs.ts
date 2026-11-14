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
  | "boards"
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

/** The tabs a contributor project shows: its work, its votes, who earned what, the talk around it, its boards, its funds and settings. */
const CONTRIBUTOR_TABS: ReadonlySet<LaunchTab> = new Set([
  "overview",
  "contributions",
  "decisions",
  "work",
  "discussion",
  "boards",
  "updates",
  "treasury",
  "manage",
]);

/** An idea has no money, decisions or treasury yet: showing those tabs empty makes the page look broken, not early. */
const IDEA_TABS: ReadonlySet<LaunchTab> = new Set([
  "overview",
  "agents",
  "discussion",
  "boards",
  "updates",
  "manage",
]);

/** The same without the helpers tab, which a contributor-only build has nothing behind. */
const IDEA_TABS_WITHOUT_RAISES: ReadonlySet<LaunchTab> = new Set([
  "overview",
  "discussion",
  "boards",
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

/** Whether a project uses a part of its page: it does, it does not, or that could not be read. */
export type TabUse = "yes" | "no" | "unknown";

/**
 * The tabs that are shown only once the project uses them: its list of updates, its boards, and its people and
 * helpers. The Discussion tab is not one of them: it is where a visitor writes the first word, so hiding it while
 * empty would leave nobody able to begin. Work, Decisions, Contributions and Funds exist only for a project that has
 * set up Shares, which is already "in use".
 */
const SHOWN_WHEN_USED: ReadonlySet<LaunchTab> = new Set([
  "updates",
  "boards",
  "agents",
]);

/**
 * Whether a tab the project's kind allows is shown to this viewer.
 *
 * The founder always gets every tab of their project: an empty Boards tab is where they make the first board, so
 * hiding it from them would hide the only way to set it up. Everyone else gets a tab once the project uses it. When
 * whether it is used could not be read, the tab is shown: a failed read never takes a part of the page away.
 */
export function tabShown(
  tab: LaunchTab,
  input: {
    isFounder: boolean;
    uses: Partial<Record<LaunchTab, TabUse>>;
  },
): boolean {
  if (input.isFounder || !SHOWN_WHEN_USED.has(tab)) return true;
  return (input.uses[tab] ?? "unknown") !== "no";
}

/** Whether the project has updates to list, from how many were found and whether the reads reached their end. */
export function updatesUse(input: {
  /** Null while the read has not answered. */
  count: number | null;
  failed: boolean;
  /** Both reads (the records and the marked posts) reached their end. */
  complete: boolean;
}): TabUse {
  if (input.count === null) return input.failed ? "unknown" : "no";
  if (input.count > 0) return "yes";
  // None found in a read that was cut short is not "none".
  return input.complete ? "no" : "unknown";
}

/**
 * The Updates tab's label. The number is said only when the project's updates were read to the end: a count from a
 * read that was cut short is "at least", and a tab must not state it as the number there is.
 */
export function updatesLabel(count: number | null, complete: boolean): string {
  return count === null || !complete ? "Updates" : `Updates (${count})`;
}
