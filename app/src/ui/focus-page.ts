/**
 * Where focus goes when what opened the pane is gone (a press that took itself off the page, such as the last of a person's
 * Shares taken out): the page's own heading, so a keyboard or screen-reader user lands at the top of what they were reading and
 * not on nothing.
 */
export function focusThePage(): void {
  let place: HTMLElement | null = null;
  for (const selector of ["main h1", "h1", "[role='main']", "main"]) {
    place = document.querySelector<HTMLElement>(selector);
    if (place) break;
  }
  if (!place) return;
  if (!place.hasAttribute("tabindex")) place.setAttribute("tabindex", "-1");
  place.focus({ preventScroll: true });
}
