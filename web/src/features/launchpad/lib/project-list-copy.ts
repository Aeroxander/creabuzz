/**
 * The few words that name the list of projects and what a project's card in it opens, so every screen says the same
 * thing. The list is called "Projects" in the top bar and as its own page's heading; "Launchpad" and "View launch" are
 * the sale's words, said only in a build that offers sales.
 *
 * Pure and alias-free: `project-list-copy.test.mjs` drives it under `node --test`.
 */

/** Where a project's back link goes and what it says: the page that lists projects. */
export function listLink(input: { contributor: boolean; raises: boolean }): {
  to: "/discover" | "/launchpad";
  label: string;
} {
  return input.contributor || !input.raises
    ? { to: "/discover", label: "Projects" }
    : { to: "/launchpad", label: "Launchpad" };
}

/** What a project's card in a list says on its link: a project is opened; only a sale is "viewed". */
export function openCardLabel(input: {
  contributor: boolean;
  raises: boolean;
}): string {
  return input.contributor || !input.raises ? "Open project" : "View launch";
}

/**
 * The founder's button that changes whether the project is in any list: it names what pressing it does, never the
 * state the page already states in the line above it.
 */
export function listingToggleLabel(unlisted: boolean): string {
  return unlisted ? "List this project" : "Take it off the lists";
}
