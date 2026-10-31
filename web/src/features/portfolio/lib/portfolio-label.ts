/**
 * What the Portfolio page is called, and who sees it in the main navigation.
 *
 * A build that offers raises calls it Portfolio (what you backed and what you built) and shows it to everyone. A
 * contributor-only build (`raisesOffered()` false) has nothing to back: it is the person's own work and Shares, so it is
 * called "Your work" and only someone with an account sees it.
 *
 * Alias-free: `portfolio-label.test.mjs` drives it under `node --test`.
 */

/** The page's name, in the navigation and as its title. */
export function portfolioLabel(raises: boolean): string {
  return raises ? "Portfolio" : "Your work";
}

/** Whether the main navigation links to the page. */
export function portfolioInNav(raises: boolean, hasAccount: boolean): boolean {
  return raises || hasAccount;
}
