/**
 * Where a person claims money owed to them: the "Money you can claim" section of the project's Money tab. A sheet that
 * mentions it ("Where you claim it") closes, the page goes to the Money tab if it is not there, and the section's heading
 * takes focus so a keyboard or screen reader lands on it.
 */

/** The id of the section's heading on the Money tab. */
export const CLAIMS_HEADING_ID = "money-claim-heading";

/** How many animation frames the page may take to show the section before the look gives up. */
const FRAMES = 30;

/** Moves to the section: `openMoneyTab` is called first when the page is not on the Money tab already. */
export function goToClaims(openMoneyTab?: () => void): void {
  openMoneyTab?.();
  let frames = 0;
  const look = () => {
    const heading = document.getElementById(CLAIMS_HEADING_ID);
    if (heading) {
      heading.scrollIntoView?.({ block: "start" });
      heading.focus();
      return;
    }
    frames += 1;
    if (frames < FRAMES) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
