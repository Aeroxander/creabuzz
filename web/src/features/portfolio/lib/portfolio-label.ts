/**
 * What the page at `/portfolio` is called, and who sees it in the main navigation.
 *
 * It is "Your projects" in every build: the projects a person started, helps and follows, and how each is keeping its
 * promises. A build that offers raises shows it to everyone (it also holds what they backed); a contributor-only build
 * (`raisesOffered()` false) shows it only to someone with an account, since everything on it is theirs.
 *
 * Alias-free: `portfolio-label.test.mjs` drives it under `node --test`.
 */

/** The page's name, in the navigation and as its title. */
export function portfolioLabel(): string {
  return "Your projects";
}

/** Whether the main navigation links to the page. */
export function portfolioInNav(raises: boolean, hasAccount: boolean): boolean {
  return raises || hasAccount;
}
